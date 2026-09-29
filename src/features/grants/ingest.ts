/**
 * Ingest オーケストレータ — cron/手動トリガーから呼ばれる
 *
 * 1. jGrants APIから一覧取得 → D1に新規保存（ON CONFLICT対応）
 * 2. 新規分をQueue投入（詳細取得→AI解析）
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq, sql, isNull } from "drizzle-orm";
import { grants, grantAiAnalyses, systemMeta } from "../../db/schema";
import { fetchGrantList, enrichGrantDetail, type RawGrant } from "./jgrants-source";
import { fetchSagaperchGrantList } from "./sagaperch-source";
import { analyzeGrant } from "./analyzer";
import { logEvent } from "../../lib/logging";
import type { Env } from "../../types";

/** cron/手動で呼ばれる: 一覧取得→D1保存→Queue投入 */
export async function ingestGrantList(env: Env): Promise<{
  total: number;
  newCount: number;
  skipped: number;
  queued: number;
}> {
  const db = drizzle(env.DB);

  // 1. jGrants (国公募) と 2. 佐賀県産業イノベーションセンター (県独自公募) を並列取得
  const [jgrantsList, sagaperchList] = await Promise.all([
    fetchGrantList().catch((err) => {
      logEvent("warn", "ingest.jgrants_failed", { error: String(err) });
      return [];
    }),
    fetchSagaperchGrantList().catch((err) => {
      logEvent("warn", "ingest.sagaperch_failed", { error: String(err) });
      return [];
    }),
  ]);

  const rawGrants: RawGrant[] = [...sagaperchList, ...jgrantsList];

  if (rawGrants.length === 0) {
    logEvent("warn", "ingest.empty_result", {
      message: "jGrants API returned 0 grants — possible upstream outage",
    });
    // Record that the cron ran, even with 0 results
    await upsertMeta(db, "last_cron_at", new Date().toISOString());
    await upsertMeta(db, "last_cron_new_count", "0");
    return { total: 0, newCount: 0, skipped: 0, queued: 0 };
  }

  let newCount = 0;
  let skipped = 0;
  let queued = 0;

  // Queue messages をバッチ送信用に収集
  const queueMessages: { type: string; payload: Record<string, unknown> }[] = [];

  for (const g of rawGrants) {
    // INSERT ... ON CONFLICT DO NOTHING でアトミックに重複チェック
    const result = await db.run(
      sql`INSERT INTO grants (title, source_ministry, source_url, published_at, deadline, raw_text, category_raw)
          VALUES (${g.title}, ${g.source_ministry}, ${g.source_url}, ${g.published_at}, ${g.deadline}, ${g.raw_text || null}, ${g.category_raw})
          ON CONFLICT (source_url) DO NOTHING`
    );

    if (!result.meta.changes || result.meta.changes === 0) {
      skipped++;
      continue;
    }

    // 挿入されたIDを取得
    const [inserted] = await db
      .select({ id: grants.id })
      .from(grants)
      .where(eq(grants.sourceUrl, g.source_url));

    if (inserted) {
      if (g.raw_text) {
        // すでに本文がある場合（県独自クローラー等）は直接AI解析へ
        queueMessages.push({
          type: "grant.analyze",
          payload: { grantId: inserted.id },
        });
      } else {
        // 詳細取得が必要な場合（jGrants等）
        queueMessages.push({
          type: "grant.fetch_detail",
          payload: { grantId: inserted.id, jgrantsId: g.jgrants_id },
        });
      }
      queued++;
    }

    newCount++;
  }

  // Queue バッチ送信
  if (queueMessages.length > 0) {
    const batches = [];
    for (let i = 0; i < queueMessages.length; i += 100) {
      batches.push(queueMessages.slice(i, i + 100));
    }
    for (const batch of batches) {
      await env.JOBS.sendBatch(
        batch.map((msg) => ({ body: msg }))
      );
    }
  }

  // Record cron run result
  const now = new Date().toISOString();
  await upsertMeta(db, "last_cron_at", now);
  await upsertMeta(db, "last_cron_new_count", String(newCount));

  logEvent("info", "ingest.complete", {
    total: rawGrants.length,
    new: newCount,
    skipped,
    queued,
  });

  return { total: rawGrants.length, newCount, skipped, queued };
}

/** Queue consumer: 詳細取得ジョブ */
export async function handleFetchDetail(
  env: Env,
  payload: { grantId: number; jgrantsId: string }
): Promise<void> {
  const db = drizzle(env.DB);
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, payload.grantId));

  if (!grant) {
    logEvent("warn", "job.fetch_detail.not_found", { grantId: payload.grantId });
    return;
  }

  // 詳細取得してraw_text・省庁名を埋める
  const rawGrant: RawGrant = {
    title: grant.title,
    source_ministry: grant.sourceMinistry,
    source_url: grant.sourceUrl,
    published_at: grant.publishedAt,
    deadline: grant.deadline,
    raw_text: grant.rawText,
    category_raw: grant.categoryRaw,
    jgrants_id: payload.jgrantsId,
  };

  await enrichGrantDetail(rawGrant);

  // 詳細取得できなかった場合はthrowしてretryさせる
  if (!rawGrant.raw_text && !grant.rawText) {
    logEvent("warn", "job.fetch_detail.no_text", { grantId: payload.grantId });
    throw new Error(`Detail fetch failed for grant ${payload.grantId} — will retry`);
  }

  // D1を更新
  await db
    .update(grants)
    .set({
      rawText: rawGrant.raw_text,
      sourceMinistry: rawGrant.source_ministry,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(grants.id, payload.grantId));

  logEvent("info", "job.fetch_detail.done", {
    grantId: payload.grantId,
    ministry: rawGrant.source_ministry,
    hasText: !!rawGrant.raw_text,
  });

  // 次のジョブ: AI解析をQueue投入
  await env.JOBS.send({
    type: "grant.analyze",
    payload: { grantId: payload.grantId },
  });
}

/** Queue consumer: AI解析ジョブ */
export async function handleAnalyze(
  env: Env,
  payload: { grantId: number; force?: boolean }
): Promise<void> {
  const db = drizzle(env.DB);
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, payload.grantId));

  if (!grant) {
    logEvent("warn", "job.analyze.not_found", { grantId: payload.grantId });
    return;
  }

  // 既に解析済みならスキップ（force: true の場合は上書き再解析）
  const [existingAnalysis] = await db
    .select({ id: grantAiAnalyses.id })
    .from(grantAiAnalyses)
    .where(eq(grantAiAnalyses.grantId, payload.grantId));

  if (existingAnalysis && !payload.force) {
    logEvent("info", "job.analyze.already_done", { grantId: payload.grantId });
    return;
  }

  const analysis = await analyzeGrant(
    {
      title: grant.title,
      source_ministry: grant.sourceMinistry,
      source_url: grant.sourceUrl,
      deadline: grant.deadline,
      raw_text: grant.rawText,
    },
    env
  );

  if (!analysis) {
    logEvent("warn", "job.analyze.failed", { grantId: payload.grantId, title: grant.title });
    throw new Error(`AI analysis failed for grant ${payload.grantId}`); // retryさせる
  }

  const categories = Array.isArray(analysis.tara_categories)
    ? analysis.tara_categories.join(",")
    : analysis.tara_categories ?? null;

  const nowIso = new Date().toISOString();

  if (existingAnalysis) {
    await db
      .update(grantAiAnalyses)
      .set({
        summaryShort: analysis.summary_short,
        supportType: analysis.support_type,
        targetEntities: analysis.target_entities,
        maxAmount: analysis.max_amount,
        subsidyRate: analysis.subsidy_rate,
        eligibleThemes: analysis.eligible_themes,
        requiredDocuments: analysis.required_documents,
        notes: analysis.notes,
        aiConfidence: analysis.ai_confidence,
        taraFitRank: analysis.tara_fit_rank,
        taraFitScore: analysis.tara_fit_score,
        taraFitReason: analysis.tara_fit_reason,
        suggestedDepartment: analysis.suggested_department,
        suggestedDepartmentReason: analysis.suggested_department_reason,
        taraUseCase: analysis.tara_use_case,
        taraCategories: categories,
        updatedAt: nowIso,
      })
      .where(eq(grantAiAnalyses.id, existingAnalysis.id));
  } else {
    await db.insert(grantAiAnalyses).values({
      grantId: payload.grantId,
      summaryShort: analysis.summary_short,
      supportType: analysis.support_type,
      targetEntities: analysis.target_entities,
      maxAmount: analysis.max_amount,
      subsidyRate: analysis.subsidy_rate,
      eligibleThemes: analysis.eligible_themes,
      requiredDocuments: analysis.required_documents,
      notes: analysis.notes,
      aiConfidence: analysis.ai_confidence,
      taraFitRank: analysis.tara_fit_rank,
      taraFitScore: analysis.tara_fit_score,
      taraFitReason: analysis.tara_fit_reason,
      suggestedDepartment: analysis.suggested_department,
      suggestedDepartmentReason: analysis.suggested_department_reason,
      taraUseCase: analysis.tara_use_case,
      taraCategories: categories,
    }).onConflictDoNothing();
  }

  logEvent("info", "job.analyze.done", {
    grantId: payload.grantId,
    rank: analysis.tara_fit_rank,
    score: analysis.tara_fit_score,
    updated: !!existingAnalysis,
  });
}

/** Upsert a system_meta key */
async function upsertMeta(db: DrizzleD1Database, key: string, value: string) {
  await db.insert(systemMeta).values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: systemMeta.key,
      set: { value, updatedAt: new Date().toISOString() },
    });
}

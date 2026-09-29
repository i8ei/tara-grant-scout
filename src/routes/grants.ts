import { Hono } from "hono";
import { desc, eq, and, or, ne, gte, like, count, max, sql, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { grants, grantAiAnalyses, systemMeta } from "../db/schema";
import type { AppContextEnv } from "../types";
import { jsonError } from "../lib/http";
import { ingestGrantList } from "../features/grants/ingest";
import { checkGrantEligibility } from "../features/grants/eligibility-checker";

const app = new Hono<AppContextEnv>()
  // LIST with SQL-level filters
  .get("/", async (c) => {
    const db = drizzle(c.env.DB);
    const rank = c.req.query("rank");
    const category = c.req.query("category");
    const q = c.req.query("q");
    const includeEnded = c.req.query("include_ended");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");

    const limit = Math.min(Number(limitParam) || 200, 500);
    const offset = Number(offsetParam) || 0;

    // Build WHERE conditions
    const conditions = [];

    // Rank filter (default: exclude C)
    if (rank) {
      conditions.push(eq(grantAiAnalyses.taraFitRank, rank));
    } else {
      conditions.push(
        or(ne(grantAiAnalyses.taraFitRank, "C"), isNull(grantAiAnalyses.taraFitRank))!
      );
    }

    // Deadline filter
    const today = new Date().toISOString().slice(0, 10);
    if (includeEnded === "true") {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      conditions.push(or(isNull(grants.deadline), gte(grants.deadline, cutoff))!);
    } else {
      conditions.push(or(isNull(grants.deadline), gte(grants.deadline, today))!);
    }

    // Category filter (comma-separated field, use LIKE)
    if (category) {
      conditions.push(
        or(
          like(grantAiAnalyses.taraCategories, `${category},%`),
          like(grantAiAnalyses.taraCategories, `%,${category},%`),
          like(grantAiAnalyses.taraCategories, `%,${category}`),
          eq(grantAiAnalyses.taraCategories, category)
        )!
      );
    }

    // Keyword search
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(
          like(grants.title, pattern),
          like(grantAiAnalyses.summaryShort, pattern)
        )!
      );
    }

    const rows = await db
      .select({
        id: grants.id,
        title: grants.title,
        sourceMinistry: grants.sourceMinistry,
        sourceUrl: grants.sourceUrl,
        publishedAt: grants.publishedAt,
        deadline: grants.deadline,
        categoryRaw: grants.categoryRaw,
        createdAt: grants.createdAt,
        summaryShort: grantAiAnalyses.summaryShort,
        taraFitRank: grantAiAnalyses.taraFitRank,
        taraFitScore: grantAiAnalyses.taraFitScore,
        suggestedDepartment: grantAiAnalyses.suggestedDepartment,
        maxAmount: grantAiAnalyses.maxAmount,
        targetEntities: grantAiAnalyses.targetEntities,
        taraCategories: grantAiAnalyses.taraCategories,
      })
      .from(grants)
      .leftJoin(grantAiAnalyses, eq(grants.id, grantAiAnalyses.grantId))
      .where(and(...conditions))
      .orderBy(desc(grants.deadline))
      .limit(limit)
      .offset(offset);

    return c.json(rows);
  })
  // ステータス（最終更新日時・件数・最終cron実行）
  .get("/status", async (c) => {
    const db = drizzle(c.env.DB);
    const [grantStats] = await db
      .select({ total: count(), lastUpdated: max(grants.updatedAt) })
      .from(grants);
    const [analysisStats] = await db
      .select({ total: count() })
      .from(grantAiAnalyses);
    const [cronAt] = await db
      .select({ value: systemMeta.value })
      .from(systemMeta)
      .where(eq(systemMeta.key, "last_cron_at"));
    const [cronNewCount] = await db
      .select({ value: systemMeta.value })
      .from(systemMeta)
      .where(eq(systemMeta.key, "last_cron_new_count"));

    return c.json({
      grants: grantStats?.total ?? 0,
      analyzed: analysisStats?.total ?? 0,
      lastUpdated: grantStats?.lastUpdated ?? null,
      lastCronAt: cronAt?.value ?? null,
      lastCronNewCount: cronNewCount ? Number(cronNewCount.value) : null,
    });
  })
  // GET ONE with full analysis
  .get("/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = Number(c.req.param("id"));

    const [grant] = await db
      .select()
      .from(grants)
      .where(eq(grants.id, id));

    if (!grant) {
      return jsonError(c, 404, "not_found", "Grant not found");
    }

    const [analysis] = await db
      .select()
      .from(grantAiAnalyses)
      .where(eq(grantAiAnalyses.grantId, id));

    return c.json({ ...grant, analysis: analysis ?? null });
  })
  // ユーザー相談：この補助金うちで使える？判定API
  .post("/:id/check", async (c) => {
    const db = drizzle(c.env.DB);
    const id = Number(c.req.param("id"));

    const [grant] = await db
      .select()
      .from(grants)
      .where(eq(grants.id, id));

    if (!grant) {
      return jsonError(c, 404, "not_found", "Grant not found");
    }

    const [analysis] = await db
      .select()
      .from(grantAiAnalyses)
      .where(eq(grantAiAnalyses.grantId, id));

    let body: { question?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty
    }

    const question = body.question?.trim();
    if (!question) {
      return jsonError(c, 400, "bad_request", "相談内容を入力してください");
    }

    const result = await checkGrantEligibility(
      {
        grantTitle: grant.title,
        sourceMinistry: grant.sourceMinistry,
        targetEntities: analysis?.targetEntities,
        eligibleThemes: analysis?.eligibleThemes,
        summaryShort: analysis?.summaryShort,
        taraUseCase: analysis?.taraUseCase,
        notes: analysis?.notes,
        rawText: grant.rawText,
        question,
      },
      c.env
    );

    return c.json(result);
  })
  // 手動ingestトリガー（ADMIN_SECRET必須）
  .post("/ingest", async (c) => {
    const secret = c.req.header("x-admin-secret");
    if (!c.env.ADMIN_SECRET || secret !== c.env.ADMIN_SECRET) {
      return jsonError(c, 401, "unauthorized", "Invalid admin secret");
    }

    const result = await ingestGrantList(c.env);
    return c.json(result);
  })
  // 一括再解析トリガー（ADMIN_SECRET必須）
  .post("/reanalyze", async (c) => {
    const secret = c.req.header("x-admin-secret");
    if (!c.env.ADMIN_SECRET || secret !== c.env.ADMIN_SECRET) {
      return jsonError(c, 401, "unauthorized", "Invalid admin secret");
    }

    const db = drizzle(c.env.DB);
    const all = c.req.query("all") === "true";

    const conditions = all
      ? []
      : [or(gte(grants.deadline, sql`date('now')`), isNull(grants.deadline))];

    const targets = await db
      .select({ id: grants.id })
      .from(grants)
      .where(and(...conditions));

    const queueMessages = targets.map((g) => ({
      type: "grant.analyze",
      payload: { grantId: g.id, force: true },
    }));

    if (queueMessages.length > 0) {
      const batches = [];
      for (let i = 0; i < queueMessages.length; i += 100) {
        batches.push(queueMessages.slice(i, i + 100));
      }
      for (const batch of batches) {
        await c.env.JOBS.sendBatch(
          batch.map((msg) => ({ body: msg }))
        );
      }
    }

    return c.json({
      success: true,
      queued: queueMessages.length,
      all,
    });
  });

export default app;

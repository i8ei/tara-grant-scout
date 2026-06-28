/**
 * AI Analyzer — 補助金情報を解析
 *
 * 主モデル: Cloudflare Workers AI (Qwen3 30B)。外部APIキー不要。
 * フォールバック: Kimi K2.5 → GPT-4o-mini（Workers AI失敗時のみ）。
 */
import { TARA_PROFILE } from "./tara-profile";
import { parseJsonFromText } from "./json-parser";
import { logEvent } from "../../lib/logging";
import { z } from "zod";

const FETCH_TIMEOUT_MS = 30_000;

const VALID_RANKS = ["A", "B", "C"] as const;
const analysisSchema = z.object({
  summary_short: z.string().default(""),
  support_type: z.string().default("その他"),
  target_entities: z.string().default(""),
  max_amount: z.string().nullable().default(null),
  subsidy_rate: z.string().nullable().default(null),
  eligible_themes: z.string().default(""),
  required_documents: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  ai_confidence: z.coerce.number().int().min(0).max(100).default(50),
  tara_fit_rank: z.string().transform((v) =>
    VALID_RANKS.includes(v as (typeof VALID_RANKS)[number]) ? v : "C"
  ),
  tara_fit_score: z.coerce.number().int().min(0).max(100).default(0),
  tara_fit_reason: z.string().default(""),
  suggested_department: z.string().default(""),
  suggested_department_reason: z.string().default(""),
  tara_use_case: z.string().default(""),
  tara_categories: z.union([z.array(z.string()), z.string()]).default([]),
});

const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

// 主モデル: Workers AI（速度・日本語品質・コストで比較検証の結果採用）
const WORKERS_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

const SYSTEM_PROMPT = `あなたは地方自治体向けの補助金アナリストです。
与えられた補助金・公募情報を分析し、指定されたJSON形式で結果を返してください。
必ず有効なJSONのみを出力してください（json）。

${TARA_PROFILE}

## 出力形式（JSON）

必ず以下のキーを持つJSONオブジェクトを返してください。それ以外のテキストは含めないでください。

{
  "summary_short": "2〜3文の要約",
  "support_type": "補助金 | 交付金 | 委託事業 | 実証事業 | その他",
  "target_entities": "対象者（自治体、農業法人、NPO等）",
  "max_amount": "補助額上限（例: 1,000万円）。不明なら null",
  "subsidy_rate": "補助率（例: 1/2、2/3）。不明なら null",
  "eligible_themes": "対象テーマ（カンマ区切り）",
  "required_documents": "主な必要書類（簡潔に）。不明なら null",
  "notes": "その他注意点。なければ null",
  "ai_confidence": 0〜100の整数。情報の確度,
  "tara_fit_rank": "A | B | C",
  "tara_fit_score": 0〜100の整数,
  "tara_fit_reason": "太良町との相性の理由（2〜3文）",
  "suggested_department": "太良町で主担当になりそうな課",
  "suggested_department_reason": "その課を推定した理由（1〜2文）",
  "tara_use_case": "太良町での具体的な活用仮説（2〜3文）",
  "tara_categories": ["該当するカテゴリをすべて選択"]
}

## tara_categories の選択肢（複数選択可）
- 農業: みかん・花卉・イチゴ・畜産・スマート農業など農業全般
- 漁業: ノリ養殖・牡蠣・アサリ・水産加工など漁業全般
- 林業: 森林整備・J-クレジット・木材利用など
- 旅館・観光: 旅館業・観光振興・地域資源活用・インバウンドなど
- 小規模事業者: 小規模事業者・商店街・事業承継・創業支援など
- インフラ・建設: 道路・港湾・上下水道・防災・建設業など
- 福祉・医療: 高齢者・障害者・子育て・医療・介護など
- 教育・文化: 学校・生涯学習・文化財・スポーツなど
- デジタル・IT: DX・情報通信・マイナンバー・テレワークなど
- 環境・エネルギー: 脱炭素・再エネ・省エネ・廃棄物・環境保全など
- 地域振興: 移住定住・関係人口・地域おこし・過疎対策など

## 判定基準

### tara_fit_rank
- A: 太良町の課題・産業に直接合致。応募を検討すべき
- B: 間接的に活用できる可能性がある。情報共有推奨
- C: 太良町との関連は薄い。参考程度

### suggested_department の候補
総務課, 企画商工課, 財政課, 町民福祉課, 健康増進課, 環境水道課, 税務課, 農林水産課, 建設課
`;

export interface GrantForAnalysis {
  title: string;
  source_ministry: string;
  source_url: string;
  deadline: string | null;
  raw_text: string | null;
}

export interface AnalysisResult {
  summary_short: string;
  support_type: string;
  target_entities: string;
  max_amount: string | null;
  subsidy_rate: string | null;
  eligible_themes: string;
  required_documents: string | null;
  notes: string | null;
  ai_confidence: number;
  tara_fit_rank: string;
  tara_fit_score: number;
  tara_fit_reason: string;
  suggested_department: string;
  suggested_department_reason: string;
  tara_use_case: string;
  tara_categories: string[] | string;
}

interface LlmProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingParam?: Record<string, unknown>;
}

async function callLlm(
  provider: LlmProvider,
  systemPrompt: string,
  userMessage: string,
  grant: GrantForAnalysis
): Promise<AnalysisResult | null> {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body: Record<string, unknown> = {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 2000,
      };
      if (provider.thinkingParam) {
        body.thinking = provider.thinkingParam;
      }

      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        const waitMs = Math.min(1000 * 2 ** attempt, 8000);
        logEvent("warn", "analyzer.retry", {
          provider: provider.model,
          status: res.status,
          attempt,
          waitMs,
          title: grant.title,
        });
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      if (!res.ok) {
        const err = await res.text();
        logEvent("error", "analyzer.api_error", {
          provider: provider.model,
          status: res.status,
          body: err.substring(0, 200),
          title: grant.title,
        });
        return null;
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const message = data.choices?.[0]?.message;

      let text = message?.content || "";
      if (!text.trim() && message?.reasoning_content) {
        logEvent("info", "analyzer.reasoning_fallback", { title: grant.title });
        text = message.reasoning_content;
      }

      const parsed = parseJsonFromText(text);
      if (!parsed) {
        logEvent("warn", "analyzer.no_json", { provider: provider.model, title: grant.title });
        return null;
      }

      const validated = analysisSchema.safeParse(parsed);
      if (!validated.success) {
        logEvent("warn", "analyzer.validation_failed", {
          provider: provider.model,
          title: grant.title,
          errors: validated.error.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
        return null;
      }

      return validated.data as AnalysisResult;
    } catch (err) {
      logEvent("error", "analyzer.exception", {
        provider: provider.model,
        title: grant.title,
        attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Workers AI でJSON解析（response_format=json_object でJSON強制） */
async function callWorkersAi(
  ai: Ai,
  systemPrompt: string,
  userMessage: string,
  grant: GrantForAnalysis
): Promise<AnalysisResult | null> {
  const MAX_RETRIES = 2;
  const label = `workers-ai:${WORKERS_AI_MODEL}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = (await ai.run(WORKERS_AI_MODEL as any, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 2000,
        response_format: { type: "json_object" },
      } as any)) as { response?: unknown };

      // response は文字列 or 既にパース済みオブジェクトのことがある
      const raw = resp?.response;
      const text =
        typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";

      const parsed = parseJsonFromText(text);
      if (!parsed) {
        logEvent("warn", "analyzer.no_json", { provider: label, title: grant.title });
        return null;
      }

      const validated = analysisSchema.safeParse(parsed);
      if (!validated.success) {
        logEvent("warn", "analyzer.validation_failed", {
          provider: label,
          title: grant.title,
          errors: validated.error.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
        return null;
      }

      return validated.data as AnalysisResult;
    } catch (err) {
      logEvent("error", "analyzer.exception", {
        provider: label,
        title: grant.title,
        attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      return null;
    }
  }

  return null;
}

export async function analyzeGrant(
  grant: GrantForAnalysis,
  ai: Ai,
  kimiApiKey?: string,
  openaiApiKey?: string
): Promise<AnalysisResult | null> {
  const userMessage = `以下の補助金・公募情報を分析し、結果をJSONで返してください。

## タイトル
${grant.title}

## 省庁
${grant.source_ministry}

## 締切
${grant.deadline || "不明"}

## URL
${grant.source_url}

## 本文
${grant.raw_text || "（本文なし — タイトルと省庁から推定してください）"}
`;

  // Primary: Workers AI (Qwen3 30B)
  const waiResult = await callWorkersAi(ai, SYSTEM_PROMPT, userMessage, grant);
  if (waiResult) return waiResult;

  // Fallback 1: Kimi K2.5
  if (kimiApiKey) {
    logEvent("info", "analyzer.fallback_to_kimi", { title: grant.title });
    const kimiResult = await callLlm(
      {
        baseUrl: KIMI_BASE_URL,
        apiKey: kimiApiKey,
        model: "kimi-k2.5",
        thinkingParam: { type: "disabled" },
      },
      SYSTEM_PROMPT,
      userMessage,
      grant
    );
    if (kimiResult) return kimiResult;
  }

  // Fallback 2: GPT-4o-mini
  if (openaiApiKey) {
    logEvent("info", "analyzer.fallback_to_openai", { title: grant.title });
    return callLlm(
      {
        baseUrl: "https://api.openai.com/v1",
        apiKey: openaiApiKey,
        model: "gpt-4o-mini",
      },
      SYSTEM_PROMPT,
      userMessage,
      grant
    );
  }

  return null;
}

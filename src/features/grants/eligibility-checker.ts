/**
 * Eligibility Checker — ユーザーの「うちで使える？」という疑問にAIが即答する
 */
import { z } from "zod";
import { parseJsonFromText } from "./json-parser";
import { logEvent } from "../../lib/logging";
import type { Env, WorkersAiBinding } from "../../types";

export const eligibilityResultSchema = z.object({
  status: z.enum(["likely", "conditional", "unlikely"]).default("conditional"),
  headline: z.string().default("条件次第で対象となる可能性があります"),
  answer: z.string().default("公募要領の対象者・対象経費をご確認ください。"),
  advice: z.string().default("役場窓口または商工会等にご相談ください。"),
});

export type EligibilityResult = z.infer<typeof eligibilityResultSchema>;

export interface EligibilityInput {
  grantTitle: string;
  sourceMinistry: string;
  targetEntities?: string | null;
  eligibleThemes?: string | null;
  summaryShort?: string | null;
  taraUseCase?: string | null;
  notes?: string | null;
  rawText?: string | null;
  question: string;
}

const CHECK_SYSTEM_PROMPT = `あなたは佐賀県太良町（たらちょう）の事業者・町民に寄り添う補助金コンシェルジュです。
ユーザーから「自分の事業や買いたいものにこの補助金が使えるか？」という相談が届きました。
提示された補助金の情報（対象者、対象経費、除外要件、概要）をもとに、親切・的確・率直に判定してください。

## 判定ルール (status)
- "likely" (使える可能性大): 制度の対象者（業種・規模）および対象経費に合致している場合
- "conditional" (条件付きで可能): 業種や規模は合致するが、特定の要件（賃上げ、省エネ基準、共同申請など）や経費の限定がある場合
- "unlikely" (原則対象外): 対象外業種、対象地域外、または購入希望物（例: 普通乗用車の本体購入、既存の運転資金・人件費など）が公募要領で禁止されている場合

## 心得
- 専門用語や官僚言葉を使わず、誰でもスッと理解できる平易な言葉で説明してください。
- 内部のAIシステム名（Workers AI, Jev, Qwen等）は一切言及しないでください。
- できない場合は「何がダメか」「どうすれば対象になりうるか、またはどの補助金なら狙えるか」の代替アドバイスを添えてください。
- 最後に必ず有効なJSONオブジェクトのみを出力してください。

## 出力JSONフォーマット
{
  "status": "likely" | "conditional" | "unlikely",
  "headline": "一目でわかる結論（20〜35文字程度。例: 福祉施設での職員負担軽減に活用できます）",
  "answer": "詳しい解説と理由（100〜160文字程度。なぜ対象になるか、またはなぜ難しいかをわかりやすく）",
  "advice": "申請に向けたワンポイントアドバイスまたは注意点（80〜120文字程度）"
}`;

const WORKERS_AI_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
] as const;

export async function checkGrantEligibility(
  input: EligibilityInput,
  env: Partial<Env>
): Promise<EligibilityResult> {
  const truncatedRaw = input.rawText
    ? input.rawText.length > 3000
      ? input.rawText.substring(0, 3000)
      : input.rawText
    : "";

  const userMessage = `【対象補助金】
タイトル: ${input.grantTitle}
管轄: ${input.sourceMinistry}
対象者: ${input.targetEntities || "不明"}
対象テーマ・経費: ${input.eligibleThemes || "不明"}
概要: ${input.summaryShort || "不明"}
特記事項: ${input.notes || "なし"}
活用想定: ${input.taraUseCase || "なし"}
${truncatedRaw ? `公募要領抜粋:\n${truncatedRaw}\n` : ""}

【ユーザーからの相談】
「${input.question}」`;

  // 1. Try Workers AI
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      try {
        logEvent("info", "eligibility.start_workers_ai", { model, title: input.grantTitle });
        const res = await env.AI.run<Record<string, unknown>>(model, {
          messages: [
            { role: "system", content: CHECK_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          max_tokens: 1000,
        });

        let rawText = "";
        if (typeof res === "string") {
          rawText = res;
        } else if (res && typeof res === "object") {
          if ("response" in res) {
            const raw = res.response;
            rawText = typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
          } else {
            rawText = JSON.stringify(res);
          }
        }

        const parsed = parseJsonFromText(rawText);
        if (parsed) {
          const validated = eligibilityResultSchema.safeParse(parsed);
          if (validated.success) {
            logEvent("info", "eligibility.success", { model, status: validated.data.status });
            return validated.data;
          }
        }
      } catch (err) {
        logEvent("warn", "eligibility.workers_ai_error", {
          model,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 2. Fallback to OpenAI if configured
  if (env.OPENAI_API_KEY) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: CHECK_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          max_tokens: 800,
          temperature: 0.2,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = data.choices?.[0]?.message?.content || "";
        const parsed = parseJsonFromText(text);
        if (parsed) {
          const validated = eligibilityResultSchema.safeParse(parsed);
          if (validated.success) {
            return validated.data;
          }
        }
      }
    } catch (err) {
      logEvent("warn", "eligibility.openai_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Static Rule-based Fallback
  return {
    status: "conditional",
    headline: "要件を満たせば活用の可能性があります",
    answer: `「${input.grantTitle}」の対象者は【${input.targetEntities || "中小企業・小規模事業者"}】です。ご計画の使途が公募要領の対象経費に適合しているか確認が必要です。`,
    advice: "具体的な機器や経費の見積書を準備し、太良町商工会または役場窓口へご相談ください。",
  };
}

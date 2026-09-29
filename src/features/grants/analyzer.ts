/**
 * AI Analyzer — Cloudflare Workers AI を使って補助金を4軸ルーブリック評価・解析
 */
import { TARA_PROFILE } from "./tara-profile";
import { parseJsonFromText } from "./json-parser";
import { logEvent } from "../../lib/logging";
import { z } from "zod";
import type { Env, WorkersAiBinding } from "../../types";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RAW_TEXT_LENGTH = 8_000;

const VALID_RANKS = ["S", "A", "B", "C"] as const;

export const analysisSchema = z.object({
  summary_short: z.string().default(""),
  support_type: z.string().default("その他"),
  target_entities: z.string().default(""),
  max_amount: z.string().nullable().default(null),
  subsidy_rate: z.string().nullable().default(null),
  eligible_themes: z.string().default(""),
  required_documents: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  ai_confidence: z.coerce.number().int().min(0).max(100).default(50),
  tara_fit_score: z.coerce.number().int().min(0).max(100).default(0),
  tara_fit_rank: z.string().transform((v) =>
    VALID_RANKS.includes(v as (typeof VALID_RANKS)[number]) ? v : "C"
  ),
  tara_fit_reason: z.string().default(""),
  suggested_department: z.string().default(""),
  suggested_department_reason: z.string().default(""),
  tara_use_case: z.string().default(""),
  tara_categories: z.union([z.array(z.string()), z.string()]).default([]),
}).transform((data) => {
  // スコアとランクの整合性を担保
  let rank = data.tara_fit_rank;
  if (data.tara_fit_score >= 80) {
    rank = "S";
  } else if (data.tara_fit_score >= 60) {
    rank = "A";
  } else if (data.tara_fit_score >= 45) {
    rank = "B";
  } else {
    rank = "C";
  }
  return {
    ...data,
    tara_fit_rank: rank,
  };
});

export const SYSTEM_PROMPT = `あなたは佐賀県太良町（たらちょう）専属の補助金アナリストです。
与えられた補助金・公募情報を厳密に精査し、太良町役場および町内事業者（農家・漁師・温泉旅館・商工業者）にとっての活用価値を評価し、指定されたJSON形式で結果を返してください。
必ず有効なJSONのみを出力してください。

${TARA_PROFILE}

## 評価基準: 4軸ルーブリック採点法（合計 0〜100点）
以下の4つの観点ごとに客観的に採点し、合計点を tara_fit_score（0〜100）として算定してください。

1. 【申請主体・適格性】（0〜25点）
   - 太良町のプレイヤー（町役場、町内みかん・花卉・イチゴ・畜産農家、竹崎カキ・ノリ養殖等の漁師、たら竹崎温泉旅館、町内小規模商工業）が応募対象に含まれるか？
   - 25点: 太良町の対象者が直接の単独申請主体として明記されている
   - 15点: 中小企業・小規模事業者枠や地方自治体枠で広く申請可能
   - 5点: 共同申請や間接的（JA・商工会・県経由等）なら申請可能
   - 0点: 大企業限定、三大都市圏限定、指定対象外地域など太良町から応募不可

2. 【太良町基幹産業・重点課題合致度】（0〜35点）
   - 太良町の主要産業・過疎地域計画の重要課題に合致しているか？
   - 30〜35点: 太良町の特産品・基幹産業（みかん/花卉/畜産、カキ/ノリ、多良岳林業、たら竹崎温泉、過疎・防災・下水道）にドンピシャで合致
   - 20〜29点: 町内事業者の一般的な設備投資、省エネ、DX、事業承継、人手不足対策に合致
   - 10〜19点: 汎用的な補助金（太良町でも使えなくはないが特段の適合性はない）
   - 0〜9点: 太良町の実態・産業構造とほとんど関連がない

3. 【補助規模・実効性】（0〜20点）
   - 補助率や補助上限が、小規模自治体や町内中小零細事業者にとって実用的か？
   - 16〜20点: 補助率が高い（2/3、3/4以上）または定額交付。小規模事業者でも自己負担が少なく使いやすい
   - 10〜15点: 補助率1/2程度、または標準的な補助金
   - 0〜9点: 自己負担比率が高すぎる、または億単位の大規模投資が必須で町内事業者には過大

4. 【申請・執行の実現性】（0〜20点）
   - 申請手続きの難易度や、採択・執行の現実性があるか？
   - 16〜20点: 申請要件が簡潔で小規模事業者・役場担当課でも無理なく対応可能
   - 10〜15点: 通常の申請書類（事業計画書等）で対応可能
   - 0〜9点: 産学官連携の複雑なコンソーシアム必須、高度な研究開発要件などハードルが極めて高い

## ランク判定（tara_fit_rank）
- S (80〜100点): 太良町の基幹産業（みかん・水産・温泉観光等）に直結する超目玉・特選補助金
- A (60〜79点): 太良町の事業者や役場が現実的に活用すべき有力・積極推奨補助金
- B (45〜59点): 条件付き・間接的に活用余地がある検討補助金
- C (0〜44点): 太良町との関連性が薄い、または申請が現実的でない補助金

## AI要約フォーマット（summary_short）
事業者が5秒で応募可否を判断できるよう、以下の4要素を含めた簡潔で具体的な構造化サマリー（120〜180文字程度）を作成してください:
「【対象】... 【使途】... 【補助】... 【アクション】...」
例: 「【対象】太良町のみかん・施設園芸農家 【使途】農業用ハウスの省エネ機器・スマート農業設備導入 【補助】上限500万円（補助率2/3） 【アクション】締切までに町農林水産課またはJAを通じて申請書を提出」

## 太良町活用仮説（tara_use_case）
単なる一般論ではなく、太良町の具体的資源（多良岳、有明海、竹崎カキ、たら竹崎温泉、みかん園の斜面等）や課題（高齢化40%、下水道普及率低、タクシー廃業等の交通課題）を踏まえた具体的な活用アイデアを2〜3文で記載してください。

## 出力形式（JSON）
必ず以下のキーを持つJSONオブジェクトのみを返してください。

{
  "summary_short": "【対象】... 【使途】... 【補助】... 【アクション】...",
  "support_type": "補助金 | 交付金 | 委託事業 | 実証事業 | その他",
  "target_entities": "対象者（自治体、農業法人、小規模事業者等）",
  "max_amount": "補助額上限（例: 1,000万円）。不明なら null",
  "subsidy_rate": "補助率（例: 2/3）。不明なら null",
  "eligible_themes": "対象テーマ（カンマ区切り）",
  "required_documents": "主な必要書類（簡潔に）。不明なら null",
  "notes": "その他注意点。なければ null",
  "ai_confidence": 0〜100の整数,
  "tara_fit_score": 0〜100の整数,
  "tara_fit_rank": "S | A | B | C",
  "tara_fit_reason": "4軸評価に基づく適合理由の解説（2〜3文）",
  "suggested_department": "太良町役場で主担当になりそうな課",
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

## suggested_department の候補
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

// ── Jev (System One) 判定用定義 ──────────────────────

export const JEV_QUESTIONS = {
  is_realistic: {
    type: "noul",
    instructions:
      "この補助金は、人口8,000人の過疎小規模自治体（佐賀県太良町）またはその町内の小規模・零細事業者（みかん農家、ノリ・牡蠣漁師、温泉旅館、個人商店等）が現実的に導入・申請可能な規模や事業内容ですか？（例：連節バスや超大型ビル新築、高度研究開発・大学連携必須など、過疎地・零細事業者に不可能なものはNo）",
  },
  applicant_type: {
    type: "choice",
    instructions: "この補助金の主な申請対象・活用主体はどれですか？",
    criteria: {
      business: "町内の民間事業者（農林水産・商工・観光・個人事業主）",
      town: "太良町役場（地方自治体）自身の公共事業・施設整備・DX等",
      ineligible: "太良町からは申請できない、または対象外（大企業限定、三大都市圏限定等）",
    },
  },
  department: {
    type: "choice",
    instructions: "太良町役場において主担当課となるべき部署はどこですか？",
    criteria: {
      kikaku: "企画商工課（商工業、観光・温泉、交通、地域DX、地域振興）",
      norin: "農林水産課（みかん・園芸・畜産、林業、水産・カニ・カキ・ノリ、漁港）",
      suido: "環境水道課（上下水道、浄化槽、脱炭素、ごみ処理）",
      kensetsu: "建設課（道路、河川、町有施設建築・インフラ）",
      fukushi: "町民福祉課・健康増進課（高齢者、子育て、太良病院、医療）",
      somu: "総務課・財政課（防災、庁舎、過疎債）",
    },
  },
  category: {
    type: "choice",
    instructions: "この補助金が最も当てはまる産業・分野カテゴリはどれですか？",
    criteria: {
      nou: "農業（みかん・園芸・畜産等）",
      gyo: "漁業（カキ・ノリ・カニ等）",
      rin: "林業（木材・森林整備等）",
      kanko: "旅館・観光",
      shoko: "小規模事業者・商工",
      infra: "インフラ・建設・交通",
      kankyo: "環境・エネルギー・脱炭素",
      dx: "デジタル・IT",
      fukushi: "福祉・医療",
      chiiki: "地域振興",
    },
  },
  scale_suitability: {
    type: "score",
    instructions:
      "小規模自治体（太良町）および町内零細事業者にとっての実用度・補助規模の適切さを採点してください",
    criteria: [
      "過大すぎる、または自己負担比率が高すぎて活用不可能",
      "自己負担が重い、または要件が厳しいが一部活用余地あり",
      "標準的な補助金（自己負担1/2程度で現実的）",
      "補助率が高く（2/3以上など）小規模事業者・町にとって極めて有利",
    ],
  },
};

const CATEGORY_MAP: Record<string, string> = {
  nou: "農業",
  gyo: "漁業",
  rin: "林業",
  kanko: "旅館・観光",
  shoko: "小規模事業者",
  infra: "インフラ・建設",
  kankyo: "環境・エネルギー",
  dx: "デジタル・IT",
  fukushi: "福祉・医療",
  chiiki: "地域振興",
};

const DEPARTMENT_MAP: Record<string, { name: string; reason: string }> = {
  kikaku: { name: "企画商工課", reason: "商工業・観光・交通・地域DXの所管部署のため" },
  norin: { name: "農林水産課", reason: "農業・林業・水産業・漁港の所管部署のため" },
  suido: { name: "環境水道課", reason: "上下水道・浄化槽・脱炭素・環境衛生の所管部署のため" },
  kensetsu: { name: "建設課", reason: "道路・河川・町有施設建築の所管部署のため" },
  fukushi: { name: "町民福祉課", reason: "高齢者・障害者・子育て・医療福祉の所管部署のため" },
  somu: { name: "総務課", reason: "防災・危機管理・庁舎管理・自治体運営の所管部署のため" },
};

const APPLICANT_MAP: Record<string, string> = {
  business: "町内民間事業者（農林水産・商工・観光・小規模事業者）",
  town: "太良町役場（地方自治体）",
  ineligible: "太良町対象外",
};

export interface JevOutput {
  answers: {
    is_realistic?: { noul: number };
    applicant_type?: { choice: string; confidence: number };
    department?: { choice: string; confidence: number };
    category?: { choice: string; confidence: number };
    scale_suitability?: { score: number; confidence: number };
  };
}

// ── 第2段階（生成LLM用）定義 ──────────────────────

export const stage2Schema = z.object({
  summary_short: z.string().default(""),
  support_type: z.string().default("補助金"),
  target_entities: z.string().default(""),
  max_amount: z.string().nullable().default(null),
  subsidy_rate: z.string().nullable().default(null),
  eligible_themes: z.string().default(""),
  required_documents: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  tara_fit_reason: z.string().default(""),
  tara_use_case: z.string().default(""),
});

export type Stage2Result = z.infer<typeof stage2Schema>;

export const STAGE2_SYSTEM_PROMPT = `あなたは佐賀県太良町（たらちょう）専属の補助金アナリストです。
与えられた補助金・公募情報から、事業者が一目で理解・判断できる要約と制度詳細を抽出し、指定されたJSON形式で返してください。
必ず有効なJSONのみを出力してください。

## 太良町の地域コンテキスト
${TARA_PROFILE}

## AI要約フォーマット（summary_short）の厳格ルール
事業者が5秒で応募可否と行動を判断できるよう、必ず以下の4要素を含めた構造化サマリー（120〜180文字程度）を作成してください:
「【誰が】... 【何に】... 【補助】... 【アクション】...」
例: 「【誰が】太良町のみかん・施設園芸農家 【何に】農業用ハウスの省エネ機器・スマート農業設備導入 【補助】上限500万円（補助率2/3） 【アクション】締切までに町農林水産課またはJAを通じて申請書を提出」

## 太良町との相性理由（tara_fit_reason）
太良町の基幹産業（みかん・水産・温泉・小規模商工等）や地域課題にどう合致するか、町内事業者や役場が活用しやすい理由を、AIや内部システム名を出さずに人間が読んで分かりやすい自然な日本語で1〜2文で解説してください。

## 太良町活用仮説（tara_use_case）
単なる一般論ではなく、太良町の具体的資源（多良岳、有明海、竹崎カキ、たら竹崎温泉、みかん園の斜面等）や課題（高齢化40%、下水道普及率低、交通課題）を踏まえた具体的な活用アイデアを2〜3文で記載してください。

## 出力形式（JSON）
必ず以下のキーを持つJSONオブジェクトのみを返してください。
{
  "summary_short": "【誰が】... 【何に】... 【補助】... 【アクション】...",
  "support_type": "補助金 | 交付金 | 委託事業 | 実証事業 | その他",
  "target_entities": "対象者（例: 町内農業法人、小規模事業者、太良町役場等）",
  "max_amount": "補助額上限（例: 1,000万円）。不明なら null",
  "subsidy_rate": "補助率（例: 2/3）。不明なら null",
  "eligible_themes": "対象テーマ（カンマ区切り）",
  "required_documents": "主な必要書類（簡潔に）。不明なら null",
  "notes": "その他注意点。なければ null",
  "tara_fit_reason": "太良町の産業・実態との相性理由（1〜2文）",
  "tara_use_case": "太良町での具体的な活用仮説（2〜3文）"
}
`;

/** Workers AI models to try in order */
const WORKERS_AI_MODELS = [
  "@cf/qwen/qwen3.8-27b",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;

/** Jev (System One) 呼び出し — Workers AI ネイティブまたは HTTP */
async function callJev(
  env: Partial<Env>,
  state: string,
  grantTitle: string
): Promise<JevOutput | null> {
  // 1. Workers AI binding (typesafe/jev)
  if (env.AI) {
    try {
      logEvent("info", "analyzer.start_jev_ai", { title: grantTitle });
      const res = await env.AI.run<Record<string, unknown>>("typesafe/jev", {
        state,
        questions: JEV_QUESTIONS,
      });

      let parsed: JevOutput | null = null;
      if (res && typeof res === "object") {
        if ("answers" in res) {
          parsed = res as unknown as JevOutput;
        } else if ("response" in res && typeof res.response === "string") {
          const json = parseJsonFromText(res.response);
          if (json && typeof json === "object" && "answers" in json) {
            parsed = json as unknown as JevOutput;
          }
        }
      }

      if (parsed?.answers?.is_realistic) {
        logEvent("info", "analyzer.jev_ai.success", {
          title: grantTitle,
          noul: parsed.answers.is_realistic.noul,
          applicant: parsed.answers.applicant_type?.choice,
          dept: parsed.answers.department?.choice,
        });
        return parsed;
      }
    } catch (err) {
      logEvent("warn", "analyzer.jev_ai.error", {
        title: grantTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. HTTP TypeSafe API (TYPESAFE_API_KEY)
  const globalEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const typesafeKey = env.TYPESAFE_API_KEY || globalEnv?.TYPESAFE_API_KEY;

  if (typesafeKey) {
    try {
      logEvent("info", "analyzer.start_jev_http", { title: grantTitle });
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${typesafeKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state,
          questions: JEV_QUESTIONS,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = (await res.json()) as JevOutput;
        if (data?.answers?.is_realistic) {
          logEvent("info", "analyzer.jev_http.success", {
            title: grantTitle,
            noul: data.answers.is_realistic.noul,
            applicant: data.answers.applicant_type?.choice,
            dept: data.answers.department?.choice,
          });
          return data;
        }
      } else {
        logEvent("warn", "analyzer.jev_http.failed", { status: res.status });
      }
    } catch (err) {
      logEvent("warn", "analyzer.jev_http.error", {
        title: grantTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
}

/** Stage 2: Workers AI を使った構造化要約生成 */
async function callStage2WorkersAi(
  ai: WorkersAiBinding,
  model: string,
  systemPrompt: string,
  userMessage: string,
  grantTitle: string
): Promise<Stage2Result | null> {
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await ai.run<Record<string, unknown>>(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 1500,
        response_format: { type: "json_object" },
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
      if (!parsed) {
        logEvent("warn", "analyzer.stage2.no_json", { model, title: grantTitle });
        return null;
      }

      const validated = stage2Schema.safeParse(parsed);
      if (!validated.success) {
        logEvent("warn", "analyzer.stage2.validation_failed", {
          model,
          title: grantTitle,
          errors: validated.error.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
        return null;
      }

      return validated.data;
    } catch (err) {
      logEvent("warn", "analyzer.stage2.error", {
        model,
        title: grantTitle,
        attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Legacy / Fallback Call Cloudflare Workers AI native binding */
async function callWorkersAi(
  ai: WorkersAiBinding,
  model: string,
  systemPrompt: string,
  userMessage: string,
  grantTitle: string
): Promise<AnalysisResult | null> {
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await ai.run<Record<string, unknown>>(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 2048,
        response_format: { type: "json_object" },
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
      if (!parsed) {
        logEvent("warn", "analyzer.workers_ai.no_json", { model, title: grantTitle });
        return null;
      }

      const validated = analysisSchema.safeParse(parsed);
      if (!validated.success) {
        logEvent("warn", "analyzer.workers_ai.validation_failed", {
          model,
          title: grantTitle,
          errors: validated.error.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
        return null;
      }

      return validated.data as AnalysisResult;
    } catch (err) {
      logEvent("warn", "analyzer.workers_ai.error", {
        model,
        title: grantTitle,
        attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Fallback HTTP LLM (OpenAI / Moonshot) */
async function callHttpLlm(
  provider: { baseUrl: string; apiKey: string; model: string; thinkingParam?: Record<string, unknown> },
  systemPrompt: string,
  userMessage: string,
  grantTitle: string
): Promise<AnalysisResult | null> {
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body: Record<string, unknown> = {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 2000,
        temperature: 0.2,
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

      if (!res.ok) {
        const err = await res.text();
        logEvent("error", "analyzer.http_error", {
          provider: provider.model,
          status: res.status,
          body: err.substring(0, 200),
          title: grantTitle,
        });
        return null;
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const message = data.choices?.[0]?.message;

      let text = message?.content || "";
      if (!text.trim() && message?.reasoning_content) {
        text = message.reasoning_content;
      }

      const parsed = parseJsonFromText(text);
      if (!parsed) {
        logEvent("warn", "analyzer.http.no_json", { provider: provider.model, title: grantTitle });
        return null;
      }

      const validated = analysisSchema.safeParse(parsed);
      if (!validated.success) {
        logEvent("warn", "analyzer.http.validation_failed", {
          provider: provider.model,
          title: grantTitle,
          errors: validated.error.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
        return null;
      }

      return validated.data as AnalysisResult;
    } catch (err) {
      logEvent("error", "analyzer.http.exception", {
        provider: provider.model,
        title: grantTitle,
        attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Stage 2 のサマリー生成を実行 */
async function runStage2Summary(
  grant: GrantForAnalysis,
  env: Partial<Env>,
  systemPrompt: string,
  userMessage: string
): Promise<Stage2Result | null> {
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      logEvent("info", "analyzer.start_stage2_workers_ai", { model, title: grant.title });
      const res = await callStage2WorkersAi(env.AI, model, systemPrompt, userMessage, grant.title);
      if (res) return res;
    }
  }

  // 外部フォールバック
  if (env.OPENAI_API_KEY) {
    const fullRes = await callHttpLlm(
      { baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: "gpt-4o-mini" },
      systemPrompt,
      userMessage,
      grant.title
    );
    if (fullRes) {
      return {
        summary_short: fullRes.summary_short,
        support_type: fullRes.support_type,
        target_entities: fullRes.target_entities,
        max_amount: fullRes.max_amount,
        subsidy_rate: fullRes.subsidy_rate,
        eligible_themes: fullRes.eligible_themes,
        required_documents: fullRes.required_documents,
        notes: fullRes.notes,
        tara_fit_reason: fullRes.tara_fit_reason,
        tara_use_case: fullRes.tara_use_case,
      };
    }
  }

  return null;
}

export async function analyzeGrant(
  grant: GrantForAnalysis,
  env: Partial<Env>
): Promise<AnalysisResult | null> {
  const truncatedText = grant.raw_text
    ? grant.raw_text.length > MAX_RAW_TEXT_LENGTH
      ? `${grant.raw_text.substring(0, MAX_RAW_TEXT_LENGTH)}\n...（以降省略）`
      : grant.raw_text
    : null;

  const state = `タイトル: ${grant.title}
省庁: ${grant.source_ministry}
締切: ${grant.deadline || "不明"}
URL: ${grant.source_url}
内容: ${truncatedText || "（本文なし — タイトルと省庁から推定）"}`;

  // ── 第1段階: Jev (System One) による決定論的適格性・採点・ルーティング ──
  const jev = await callJev(env, state, grant.title);

  if (jev?.answers?.is_realistic) {
    const isRealisticNoul = jev.answers.is_realistic.noul ?? 0.5;
    const applicantType = jev.answers.applicant_type?.choice ?? "business";
    const deptKey = jev.answers.department?.choice || "kikaku";
    const dept = DEPARTMENT_MAP[deptKey] || { name: "企画商工課", reason: "産業振興担当のため" };
    const catKey = jev.answers.category?.choice || "その他";
    const cat = CATEGORY_MAP[catKey] || catKey;
    const scaleSuitability = jev.answers.scale_suitability?.score ?? 1.5;
    const normalizedScale = Math.min(1, Math.max(0, scaleSuitability / 3));

    // 早期足切り判定: 太良町対象外、または非現実的 (noul < 0.20)
    if (applicantType === "ineligible" || isRealisticNoul < 0.20) {
      const score = Math.min(35, Math.round(isRealisticNoul * 100));
      logEvent("info", "analyzer.jev.early_reject", { title: grant.title, noul: isRealisticNoul, score });
      return {
        summary_short: "【対象外】過疎小規模自治体（太良町）および町内事業者の規模・申請要件に合致しないため、推薦対象外（C判定）です。",
        support_type: "その他",
        target_entities: APPLICANT_MAP[applicantType] || "太良町対象外",
        max_amount: null,
        subsidy_rate: null,
        eligible_themes: cat,
        required_documents: null,
        notes: null,
        ai_confidence: 90,
        tara_fit_rank: "C",
        tara_fit_score: score,
        tara_fit_reason: "太良町の地域規模や町内事業者の実情と乖離しており、大都市圏や大規模インフラ向けの制度のため活用は困難です。",
        suggested_department: dept.name,
        suggested_department_reason: dept.reason,
        tara_use_case: "該当なし",
        tara_categories: [cat],
      };
    }

    // 適合案件（S/A/B/Cランク候補）: スコア計算 (0〜100)
    const fitScore = Math.min(100, Math.max(0, Math.round((isRealisticNoul * 0.6 + normalizedScale * 0.4) * 100)));
    const fitRank = fitScore >= 80 ? "S" : fitScore >= 60 ? "A" : fitScore >= 45 ? "B" : "C";

    // ── 第2段階: 生成LLMで「5秒要約」と「活用仮説」を生成 ──
    const userMessage = `以下の補助金・公募情報から、指定のJSON形式で要約と制度詳細を抽出してください。

## タイトル
${grant.title}

## 省庁
${grant.source_ministry}

## 締切
${grant.deadline || "不明"}

## 本文
${truncatedText || "（本文なし）"}
`;

    const stage2 = await runStage2Summary(grant, env, STAGE2_SYSTEM_PROMPT, userMessage);

    return {
      summary_short:
        stage2?.summary_short ||
        `【誰が】${APPLICANT_MAP[applicantType] || "町内事業者"} 【何に】${grant.title}の取組支援 【補助】公募要領参照 【アクション】所管課（${dept.name}）へ相談`,
      support_type: stage2?.support_type || "補助金",
      target_entities: stage2?.target_entities || APPLICANT_MAP[applicantType] || "小規模事業者・町役場",
      max_amount: stage2?.max_amount || null,
      subsidy_rate: stage2?.subsidy_rate || null,
      eligible_themes: stage2?.eligible_themes || cat,
      required_documents: stage2?.required_documents || null,
      notes: stage2?.notes || null,
      ai_confidence: 90,
      tara_fit_rank: fitRank,
      tara_fit_score: fitScore,
      tara_fit_reason:
        stage2?.tara_fit_reason ||
        `${cat}をはじめとする太良町の基幹産業や地域課題に合致し、町内事業者や役場にとって実効性の高い制度設計です。`,
      suggested_department: dept.name,
      suggested_department_reason: dept.reason,
      tara_use_case: stage2?.tara_use_case || `太良町における${cat}関連施策・事業者での活用が期待されます。`,
      tara_categories: [cat],
    };
  }

  // ── フォールバック: Jev未稼働時は従来の単一生成LLMパイプラインを実行 ──
  logEvent("info", "analyzer.fallback_legacy_pipeline", { title: grant.title });
  const legacyUserMessage = `以下の補助金・公募情報を分析し、結果をJSONで返してください。

## タイトル
${grant.title}

## 省庁
${grant.source_ministry}

## 締切
${grant.deadline || "不明"}

## URL
${grant.source_url}

## 本文
${truncatedText || "（本文なし — タイトルと省庁から推定してください）"}
`;

  // 1. Workers AI
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      logEvent("info", "analyzer.start_workers_ai", { model, title: grant.title });
      const result = await callWorkersAi(env.AI, model, SYSTEM_PROMPT, legacyUserMessage, grant.title);
      if (result) {
        logEvent("info", "analyzer.workers_ai.success", { model, title: grant.title, score: result.tara_fit_score, rank: result.tara_fit_rank });
        return result;
      }
    }
  }

  // 2. OpenAI GPT-4o-mini
  if (env.OPENAI_API_KEY) {
    logEvent("info", "analyzer.fallback_to_openai", { title: grant.title });
    const result = await callHttpLlm(
      { baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: "gpt-4o-mini" },
      SYSTEM_PROMPT,
      legacyUserMessage,
      grant.title
    );
    if (result) return result;
  }

  // 3. Kimi
  if (env.KIMI_API_KEY) {
    logEvent("info", "analyzer.fallback_to_kimi", { title: grant.title });
    const result = await callHttpLlm(
      {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: env.KIMI_API_KEY,
        model: "kimi-k2.5",
        thinkingParam: { type: "disabled" },
      },
      SYSTEM_PROMPT,
      legacyUserMessage,
      grant.title
    );
    if (result) return result;
  }

  return null;
}



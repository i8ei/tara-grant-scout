import { describe, it, expect, vi } from "vitest";
import { analysisSchema, analyzeGrant } from "../src/features/grants/analyzer";
import type { Env, WorkersAiBinding } from "../src/types";

describe("analysisSchema", () => {
  it("should validate and map rank S when score is >= 80", () => {
    const raw = {
      summary_short: "【対象】農家 【使途】省エネ機器 【補助】上限500万円 【アクション】申請書提出",
      support_type: "補助金",
      target_entities: "町内農家",
      max_amount: "500万円",
      subsidy_rate: "2/3",
      eligible_themes: "農業,省エネ",
      required_documents: "申請書,事業計画書",
      notes: null,
      ai_confidence: 90,
      tara_fit_score: 85,
      tara_fit_rank: "B", // score is 85, should be adjusted to S
      tara_fit_reason: "太良町のみかん農家に直結する支援",
      suggested_department: "農林水産課",
      suggested_department_reason: "農業振興事業のため",
      tara_use_case: "ハウスみかん農家でのヒートポンプ導入",
      tara_categories: ["農業"],
    };

    const parsed = analysisSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tara_fit_rank).toBe("S");
      expect(parsed.data.tara_fit_score).toBe(85);
    }
  });

  it("should map rank A when score is 60-79", () => {
    const raw = {
      summary_short: "【対象】中小企業 【使途】DX 【補助】上限100万円 【アクション】Web申請",
      support_type: "補助金",
      target_entities: "小規模事業者",
      max_amount: "100万円",
      subsidy_rate: "1/2",
      eligible_themes: "IT",
      required_documents: null,
      notes: null,
      ai_confidence: 80,
      tara_fit_score: 65,
      tara_fit_rank: "C", // score is 65, should be adjusted to A
      tara_fit_reason: "汎用的なIT導入補助",
      suggested_department: "企画商工課",
      suggested_department_reason: "商工振興のため",
      tara_use_case: "町内商店でのPOSレジ導入",
      tara_categories: ["小規模事業者", "デジタル・IT"],
    };

    const parsed = analysisSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tara_fit_rank).toBe("A");
      expect(parsed.data.tara_fit_score).toBe(65);
    }
  });

  it("should map rank B when score is 45-59", () => {
    const raw = {
      summary_short: "【対象】中小企業 【使途】省エネ 【補助】上限50万円 【アクション】申請",
      support_type: "補助金",
      target_entities: "小規模事業者",
      max_amount: "50万円",
      subsidy_rate: "1/2",
      eligible_themes: "環境",
      required_documents: null,
      notes: null,
      ai_confidence: 75,
      tara_fit_score: 50,
      tara_fit_rank: "A", // score is 50, should be adjusted to B
      tara_fit_reason: "省エネ改修支援",
      suggested_department: "環境水道課",
      suggested_department_reason: "環境衛生のため",
      tara_use_case: "店舗のLED化",
      tara_categories: ["環境・エネルギー"],
    };

    const parsed = analysisSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tara_fit_rank).toBe("B");
      expect(parsed.data.tara_fit_score).toBe(50);
    }
  });

  it("should map rank C when score is < 50", () => {
    const raw = {
      summary_short: "【対象】大企業 【使途】半導体工場 【補助】上限10億円 【アクション】公募",
      support_type: "補助金",
      target_entities: "大企業",
      max_amount: "10億円",
      subsidy_rate: "1/3",
      eligible_themes: "先端技術",
      required_documents: null,
      notes: null,
      ai_confidence: 95,
      tara_fit_score: 10,
      tara_fit_rank: "A",
      tara_fit_reason: "太良町には大企業・半導体工場がないため対象外",
      suggested_department: "企画商工課",
      suggested_department_reason: "産業担当",
      tara_use_case: "該当なし",
      tara_categories: [],
    };

    const parsed = analysisSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tara_fit_rank).toBe("C");
      expect(parsed.data.tara_fit_score).toBe(10);
    }
  });
});

describe("analyzeGrant with Jev + Workers AI two-stage pipeline", () => {
  it("should process viable grant through Jev and Stage 2 Workers AI", async () => {
    const mockJev = {
      answers: {
        is_realistic: { noul: 0.88 },
        applicant_type: { choice: "business", confidence: 0.95 },
        department: { choice: "norin", confidence: 0.98 },
        category: { choice: "nou", confidence: 0.92 },
        scale_suitability: { score: 2.8, confidence: 0.9 },
      },
    };

    const mockStage2 = {
      summary_short: "【誰が】太良町のみかん・園芸農家 【何に】省エネ機器導入 【補助】上限500万円（補助率2/3） 【アクション】締切までに農林水産課へ提出",
      support_type: "補助金",
      target_entities: "町内みかん農家",
      max_amount: "500万円",
      subsidy_rate: "2/3",
      eligible_themes: "農業,省エネ",
      required_documents: "申請書",
      notes: null,
      tara_use_case: "傾斜地みかん園での作業負担軽減",
    };

    const mockAi: WorkersAiBinding = {
      run: vi.fn().mockImplementation((model: string) => {
        if (model === "typesafe/jev") {
          return Promise.resolve(mockJev);
        }
        return Promise.resolve({ response: JSON.stringify(mockStage2) });
      }),
    };

    const env: Partial<Env> = { AI: mockAi };

    const result = await analyzeGrant(
      {
        title: "スマート農業導入実証事業",
        source_ministry: "農林水産省",
        source_url: "https://example.com/grant/1",
        deadline: "2026-10-31",
        raw_text: "スマート農業機器の導入支援...",
      },
      env
    );

    expect(mockAi.run).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result?.tara_fit_rank).toBe("S");
    expect(result?.suggested_department).toBe("農林水産課");
    expect(result?.summary_short).toContain("【誰が】");
  });

  it("should early-reject out-of-scale grant (Rank C) without calling Stage 2", async () => {
    const mockJev = {
      answers: {
        is_realistic: { noul: 0.05 },
        applicant_type: { choice: "town", confidence: 0.5 },
        department: { choice: "kikaku", confidence: 0.6 },
        category: { choice: "infra", confidence: 0.8 },
        scale_suitability: { score: 0.2, confidence: 0.95 },
      },
    };

    const mockAi: WorkersAiBinding = {
      run: vi.fn().mockImplementation((model: string) => {
        if (model === "typesafe/jev") {
          return Promise.resolve(mockJev);
        }
        throw new Error("Stage 2 should not be called for early rejected grant");
      }),
    };

    const env: Partial<Env> = { AI: mockAi };

    const result = await analyzeGrant(
      {
        title: "ハイブリッド連節バス導入事業",
        source_ministry: "環境省",
        source_url: "https://example.com/grant/bus",
        deadline: "2026-10-31",
        raw_text: "連節バス購入費用の一部を補助...",
      },
      env
    );

    // Only Jev was called; Stage 2 was skipped!
    expect(mockAi.run).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.tara_fit_rank).toBe("C");
    expect(result?.tara_fit_score).toBeLessThan(50);
    expect(result?.summary_short).toContain("【対象外】");
  });

  it("should fallback to legacy single-stage LLM if Jev is unavailable", async () => {
    const mockLegacy = {
      summary_short: "【誰が】小規模事業者 【使途】販路開拓 【補助】上限200万円 【アクション】商工会相談",
      support_type: "補助金",
      target_entities: "小規模事業者",
      max_amount: "200万円",
      subsidy_rate: "2/3",
      eligible_themes: "販路開拓",
      required_documents: null,
      notes: null,
      ai_confidence: 80,
      tara_fit_score: 75,
      tara_fit_rank: "A",
      tara_fit_reason: "町内事業者に適合",
      suggested_department: "企画商工課",
      suggested_department_reason: "商工振興のため",
      tara_use_case: "商店街でのPR",
      tara_categories: ["小規模事業者"],
    };

    const mockAi: WorkersAiBinding = {
      run: vi.fn().mockImplementation((model: string) => {
        if (model === "typesafe/jev") {
          throw new Error("Jev not available in this environment");
        }
        return Promise.resolve({ response: JSON.stringify(mockLegacy) });
      }),
    };

    // Temporarily clear TYPESAFE_API_KEY to test pure fallback
    const origKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    try {
      const result = await analyzeGrant(
        {
          title: "小規模持続化補助金",
          source_ministry: "中小企業庁",
          source_url: "https://example.com/grant/2",
          deadline: "2026-10-31",
          raw_text: "小規模事業者の販路開拓支援...",
        },
        { AI: mockAi }
      );

      expect(result).not.toBeNull();
      expect(result?.tara_fit_rank).toBe("A");
      expect(result?.suggested_department).toBe("企画商工課");
    } finally {
      if (origKey) process.env.TYPESAFE_API_KEY = origKey;
    }
  });
});


import { describe, it, expect, vi } from "vitest";
import { checkGrantEligibility } from "../src/features/grants/eligibility-checker";
import type { Env } from "../src/types";

describe("checkGrantEligibility", () => {
  it("should return likely result when Workers AI returns positive evaluation", async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({
          status: "likely",
          headline: "介護・福祉事業所での導入にぴったり合致しています",
          answer: "エイジフレンドリー補助金は社会福祉法人も対象であり、職員の負担軽減機器の導入に活用可能です。",
          advice: "60歳以上の職員がいることを要件としているため、申請時に雇用状況をご確認ください。",
        }),
      }),
    };

    const env: Partial<Env> = { AI: mockAi as any };

    const result = await checkGrantEligibility(
      {
        grantTitle: "エイジフレンドリー補助金",
        sourceMinistry: "厚生労働省",
        targetEntities: "町内中小・小規模事業者、社会福祉法人等",
        eligibleThemes: "高齢者の労働災害防止、身体的負担軽減設備の導入",
        summaryShort: "【誰が】高齢労働者を雇用する事業者 【何に】負担軽減リフト等 【補助】上限100万（1/2）",
        question: "デイサービスなんですが、入浴介助リフトの導入に使えますか？",
      },
      env
    );

    expect(result.status).toBe("likely");
    expect(result.headline).toContain("介護・福祉事業所");
    expect(result.answer).toContain("エイジフレンドリー補助金");
    expect(mockAi.run).toHaveBeenCalled();
  });

  it("should return unlikely result when user asks for prohibited expense like personal car", async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({
          status: "unlikely",
          headline: "通常の普通乗用車・送迎車の購入は対象外です",
          answer: "本補助金では汎用的な車両本体の購入は対象外経費と規定されています。",
          advice: "車両本体ではなく、リフト等の福祉架装部分のみであれば対象となる場合があります。",
        }),
      }),
    };

    const env: Partial<Env> = { AI: mockAi as any };

    const result = await checkGrantEligibility(
      {
        grantTitle: "小規模事業者持続化補助金",
        sourceMinistry: "経済産業省",
        targetEntities: "小規模事業者",
        eligibleThemes: "販路開拓、業務効率化",
        question: "日常業務用の軽トラックの新車を買いたいです",
      },
      env
    );

    expect(result.status).toBe("unlikely");
    expect(result.headline).toContain("対象外");
  });

  it("should fallback gracefully when AI service fails", async () => {
    const mockAi = {
      run: vi.fn().mockRejectedValue(new Error("AI service unavailable")),
    };

    const env: Partial<Env> = { AI: mockAi as any };

    const result = await checkGrantEligibility(
      {
        grantTitle: "働き方改革推進支援助成金",
        sourceMinistry: "厚生労働省",
        targetEntities: "中小企業事業主",
        question: "保育所でタブレット端末を購入できますか？",
      },
      env
    );

    expect(result.status).toBe("conditional");
    expect(result.headline).toBeDefined();
    expect(result.answer).toContain("働き方改革推進支援助成金");
  });
});

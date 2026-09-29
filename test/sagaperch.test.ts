import { describe, it, expect } from "vitest";
import {
  parseSagaperchListHtml,
  parseSagaperchDetailHtml,
  extractDeadlineFromText,
  stripHtml,
} from "../src/features/grants/sagaperch-source";

describe("sagaperch-source", () => {
  it("should extract subsidy items from list HTML and ignore採択結果", () => {
    const sampleHtml = `
      <ul class="news_list">
        <li>
          <a href="https://sagaperch.jp/news/000430.php" class="new">
            <span class="category">補助金</span>
            <span class="date">2026.09.28</span>
            <span class="title"><span>【採択結果】佐賀県伝統産業関連中小企業生産性向上支援補助金</span></span>
          </a>
        </li>
        <li>
          <a href="/news/000426.php">
            <span class="category">補助金</span>
            <span class="date">2026.09.25</span>
            <span class="title"><span>「第８弾」佐賀県中小企業生産性向上支援補助金の募集について</span></span>
          </a>
        </li>
        <li>
          <a href="https://sagaperch.jp/news/000433.php">
            <span class="category">お知らせ</span>
            <span class="date">2026.09.25</span>
            <span class="title"><span>令和8年度サガ・クリエイティブコネクト補助金　3次募集開始のお知らせ</span></span>
          </a>
        </li>
      </ul>
    `;

    const items = parseSagaperchListHtml(sampleHtml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("「第８弾」佐賀県中小企業生産性向上支援補助金の募集について");
    expect(items[0].url).toBe("https://sagaperch.jp/news/000426.php");
    expect(items[0].publishedAt).toBe("2026-09-25");

    expect(items[1].title).toBe("令和8年度サガ・クリエイティブコネクト補助金　3次募集開始のお知らせ");
  });

  it("should extract deadline accurately from detail text", () => {
    const text = `
      ６．応募手続き等
      （１）提出期間
      令和8年9月25日（金）～10月23日（金）
      ※申請期限後に審査を行い、採択者を決定します。
    `;

    const deadline = extractDeadlineFromText(text, 2026);
    expect(deadline).toBe("2026-10-23");
  });

  it("should parse detail HTML content and strip tags", () => {
    const sampleDetail = `
      <article class="news news_detail">
        <section class="detail">
          <div class="inner">
            <div class="content">
              <p>原材料・エネルギー価格高騰支援。</p><br />
              <strong>提出期間</strong><br />
              令和8年9月25日（金）～10月23日（金）
            </div>
            <div class="buttons">
              <a href="/news/">戻る</a>
            </div>
          </div>
        </section>
      </article>
    `;

    const result = parseSagaperchDetailHtml(sampleDetail);
    expect(result.rawText).toContain("原材料・エネルギー価格高騰支援。");
    expect(result.rawText).toContain("提出期間");
    expect(result.deadline).toBe("2026-10-23");
  });
});

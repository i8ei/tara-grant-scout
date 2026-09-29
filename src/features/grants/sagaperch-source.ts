/**
 * 佐賀県産業イノベーションセンター（sagaperch.jp）補助金クローラー
 *
 * 佐賀県独自の中小企業支援・生産性向上・DX・新商品開発補助金を直接クロール
 */
import { logEvent } from "../../lib/logging";
import type { RawGrant } from "./jgrants-source";

const FETCH_TIMEOUT_MS = 15_000;
const SUBSIDY_LIST_URL = "https://sagaperch.jp/news/subsidy.php";
const BASE_URL = "https://sagaperch.jp";

interface SagaperchListItem {
  url: string;
  title: string;
  publishedAt: string | null;
}

/** HTMLテキストからタグを除去してプレーンテキスト化 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** 一覧HTMLから公募記事一覧を抽出（採択結果や様式配布は除外） */
export function parseSagaperchListHtml(html: string): SagaperchListItem[] {
  const items: SagaperchListItem[] = [];

  // <li> 内の <a href="...">...</a> を正規表現で抽出
  const liRegex = /<li>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = liRegex.exec(html)) !== null) {
    let url = match[1];
    if (url.startsWith("/")) {
      url = `${BASE_URL}${url}`;
    } else if (!url.startsWith("http")) {
      url = `${BASE_URL}/news/${url}`;
    }

    const inner = match[2];

    // 日付を抽出 (例: 2026.09.25)
    const dateMatch = inner.match(/<span class="date">(\d{4})\.(\d{2})\.(\d{2})<\/span>/);
    const publishedAt = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

    // タイトルを抽出
    const titleMatch = inner.match(/<span class="title"><span>([\s\S]*?)<\/span><\/span>/);
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    if (!rawTitle) continue;

    // 採択結果・交付決定・結果公表・セミナー等は公募ではないためスキップ
    if (
      rawTitle.includes("採択結果") ||
      rawTitle.includes("交付決定") ||
      rawTitle.includes("様式について") ||
      rawTitle.includes("セミナー") ||
      rawTitle.includes("カレッジ") ||
      rawTitle.includes("採用情報")
    ) {
      continue;
    }

    items.push({
      url,
      title: rawTitle,
      publishedAt,
    });
  }

  return items;
}

/** 本文HTMLから締切日（YYYY-MM-DD）を推定 */
export function extractDeadlineFromText(text: string, currentYear = 2026): string | null {
  // パターン1: 提出期間・募集期間・締切 に続く日付範囲（例: 〜10月23日、〜令和8年10月23日）
  const rangeMatch = text.match(
    /(?:提出期間|公募期間|募集期間|申請期間|受付期間|期間|期限)[\s\S]{0,100}?[～~ー―-]\s*(?:令和(\d+)年)?\s*(\d{1,2})月(\d{1,2})日/
  );
  if (rangeMatch) {
    const reiwa = rangeMatch[1] ? Number(rangeMatch[1]) : null;
    const year = reiwa ? 2018 + reiwa : currentYear;
    const month = String(rangeMatch[2]).padStart(2, "0");
    const day = String(rangeMatch[3]).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // パターン2: 〜10月23日（金）
  const simpleRangeMatch = text.match(/[～~ー―-]\s*(\d{1,2})月(\d{1,2})日[（\(][月火水木金土日][）\)]/);
  if (simpleRangeMatch) {
    const month = String(simpleRangeMatch[1]).padStart(2, "0");
    const day = String(simpleRangeMatch[2]).padStart(2, "0");
    return `${currentYear}-${month}-${day}`;
  }

  return null;
}

/** 詳細ページHTMLから本文と締切を抽出 */
export function parseSagaperchDetailHtml(html: string): { rawText: string; deadline: string | null } {
  const contentMatch = html.match(/<div class="content">([\s\S]*?)<\/div>\s*<div class="buttons">/i) ||
    html.match(/<div class="content">([\s\S]*?)<\/div>/i);

  if (!contentMatch) {
    return { rawText: "", deadline: null };
  }

  const rawText = stripHtml(contentMatch[1]);
  const deadline = extractDeadlineFromText(rawText);

  return { rawText, deadline };
}

/** 佐賀県産業イノベーションセンターの公募一覧を取得してRawGrant配列で返す */
export async function fetchSagaperchGrantList(): Promise<RawGrant[]> {
  try {
    logEvent("info", "crawler.sagaperch.start", { url: SUBSIDY_LIST_URL });

    const res = await fetch(SUBSIDY_LIST_URL, {
      headers: {
        "User-Agent": "TaraGrantScout/1.0 (+https://tara-grant-scout.ichevi.workers.dev)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logEvent("warn", "crawler.sagaperch.list_failed", { status: res.status });
      return [];
    }

    const html = await res.text();
    const items = parseSagaperchListHtml(html);

    logEvent("info", "crawler.sagaperch.items_found", { count: items.length });

    const grants: RawGrant[] = [];

    // 直近の公募記事（最大5件）の詳細を取得
    for (const item of items.slice(0, 5)) {
      try {
        const detailRes = await fetch(item.url, {
          headers: {
            "User-Agent": "TaraGrantScout/1.0 (+https://tara-grant-scout.ichevi.workers.dev)",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!detailRes.ok) continue;

        const detailHtml = await detailRes.text();
        const { rawText, deadline } = parseSagaperchDetailHtml(detailHtml);

        grants.push({
          title: item.title,
          source_ministry: "佐賀県（産業イノベーションセンター）",
          source_url: item.url,
          published_at: item.publishedAt,
          deadline,
          raw_text: rawText || null,
          category_raw: "佐賀県産業振興・中小企業支援",
          jgrants_id: "",
        });
      } catch (err) {
        logEvent("warn", "crawler.sagaperch.detail_failed", {
          url: item.url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logEvent("info", "crawler.sagaperch.complete", { successCount: grants.length });
    return grants;
  } catch (err) {
    logEvent("error", "crawler.sagaperch.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

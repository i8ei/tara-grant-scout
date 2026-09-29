# CLAUDE.md

## プロジェクト概要

太良町（佐賀県）向けの補助金AIスカウトシステム。国（jGrants API）および佐賀県産業イノベーションセンターの公募情報を毎日自動収集し、太良町目線でAIが適合度を4段階評価（S/A/B/C）し、要約と使い道を即答する。Cloudflare完結（Workers + D1 + Queues + Workers AI + Cron Triggers）。

本番: https://tara-grant-scout.ichevi.workers.dev

## 技術スタック

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + TanStack Query + Wouter
- **Backend**: Hono v4 on Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM
- **非同期・定期実行**: Cloudflare Queues + Cron Triggers (0 21 * * * = JST 6:00)
- **AI パイプライン**:
  - 第1段階: TypeSafe Jev (System One) による決定論的適格性・早期足切り
  - 第2段階: Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`, Llama 3.3 70B 等) による構造化サマリー生成
  - 相談窓口: Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) によるエッジ即時回答
  - （フォールバック: OpenAI gpt-4o-mini）

## 開発コマンド

```bash
npm run dev              # ローカル開発サーバー (Vite + Cloudflare)
npm run build            # クライアント & Worker ビルド
npm run deploy           # ビルド + Cloudflare Workers 本番デプロイ
npm test                 # Vitest ユニットテスト実行
npm run db:migrate       # D1マイグレーション（ローカル）
npm run db:migrate:remote # D1マイグレーション（リモート）
```

## 自動 ingest パイプライン（本番）

```
Cron (0 21 * * * = JST 6:00)
  → ingestGrantList():
      ├─ jGrants API (国の公募)
      └─ sagaperch-source.ts (佐賀県産業イノベーションセンターの独自公募)
      → D1 grants テーブルに新規保存 (ON CONFLICT DO NOTHING)
  → Queue:
      ├─ grant.fetch_detail (jGrants用: 詳細HTMLから本文と省庁名を補完)
      └─ grant.analyze (Jev + Workers AI による適合度評価・構造化サマリー)
```

手動トリガー:
- `POST /api/grants/ingest` (ヘッダ: `x-admin-secret`)
- `POST /api/grants/reanalyze` (ヘッダ: `x-admin-secret`, クエリ: `all=true` で全件)

## DB構造

### grants テーブル
- `id`, `title`, `source_ministry`, `source_url`, `published_at`, `deadline`, `raw_text`, `category_raw`

### grant_ai_analyses テーブル
- `grant_id` (FK → grants.id)
- `summary_short` (【誰が】【何に】【補助】【アクション】形式の構造化サマリー)
- `support_type`, `target_entities`, `max_amount`, `subsidy_rate`
- `eligible_themes`, `required_documents`, `notes`
- `ai_confidence`, `tara_fit_rank` (S / A / B / C), `tara_fit_score` (0〜100点)
- `tara_fit_reason`, `suggested_department`, `suggested_department_reason`, `tara_use_case`
- `tara_categories` (カンマ区切り: 福祉・医療, 農業, 漁業, 旅館・観光, 小規模事業者 等)

## ランク基準

- **S (80点以上)**: 【超特選】太良町の基幹産業（みかん・カキ・ノリ・旅館等）に直結する重要制度
- **A (60〜79点)**: 【積極推奨】町内事業者の本命制度（エイジフレンドリー、佐賀県中小企業生産性向上、働き方改革等）
- **B (45〜59点)**: 【条件付き】共同申請や特定要件を満たせば活用可能
- **C (44点以下)**: 太良町には不適・対象外（非現実的案件を自動排除、デフォルト一覧から除外）

## API エンドポイント

| エンドポイント | 内容 |
|---|---|
| `GET /api/grants` | 一覧（フィルタ: `rank`, `category`, `q`, `include_ended`） |
| `GET /api/grants/status` | ステータス（収集件数・解析件数・最終Cron日時） |
| `GET /api/grants/:id` | 詳細 + AI解析結果 |
| `POST /api/grants/:id/check` | AIクイック相談（ボディ: `{ question: string }`） |
| `POST /api/grants/ingest` | 手動ingest（要 `x-admin-secret`） |
| `POST /api/grants/reanalyze` | 一括再解析（要 `x-admin-secret`） |

## コード規約と設計上の注意点

- **ゼロ内部用語原則**: 画面およびAI出力文には「Jev」「Workers AI」「確度」などの内部システム名を絶対に出さない。町民・事業者が読んで自然な日本語で統一する。
- **軽量エッジ推論**: `POST /api/grants/:id/check` には高速応答可能な `@cf/meta/llama-3.1-8b-instruct-fp8` を優先採用し、1〜2秒以内のレスポンスを維持する。
- **CSRF & CORS**: SPA同一オリジン（`new URL(c.req.url).origin`）および `wrangler.jsonc` の `CORS_ORIGIN` に設定されたオリジンからの安全な通信を許可する。
- **安全なJSONパース**: AI出力パースには `parseJsonFromText` を使用し、マークダウンコードブロックや余分なテキストが含まれていても安定してJSONオブジェクトを抽出する。

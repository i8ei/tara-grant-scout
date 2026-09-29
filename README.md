# 補助金スカウト @太良

太良町（佐賀県）向け補助金AI発見システム。国（全省庁統合 jGrants）および佐賀県の補助金情報を毎日自動収集し、太良町の事業者・現場目線でAIが適合度を判定・要約する。

**本番URL: https://tara-grant-scout.ichevi.workers.dev**

---

## 主な特徴

1. **二重データソース（国 ＋ 佐賀県独自）**
   - **jGrants API（デジタル庁）**: 全省庁の中小企業・産業支援補助金を網羅。
   - **佐賀県産業イノベーションセンター クローラー**: 県独自の中小企業生産性向上支援補助金やDX・新商品開発補助金を自動収集。
2. **2段階AIパイプライン（Jev ＋ Workers AI）**
   - **第1段階（Jev）**: 太良町への適格性（申請主体・産業合致度・過大度）をミリ秒で判定し、無関係な案件（鉱山、連節バス等）を早期足切り。
   - **第2段階（Cloudflare Workers AI）**: 有望案件に対して「【誰が】【何に】【補助】【アクション】」の5秒要約と活用仮説を生成。
3. **S / A / B / C の4段階ランク評価**
   - **S（80点以上）**: 【超特選】太良町の基幹産業（みかん・カキ・ノリ・旅館等）に直結する最重要補助金
   - **A（60〜79点）**: 【積極推奨】町内事業者の本命制度（エイジフレンドリー、佐賀県中小企業生産性向上、働き方改革等）
   - **B（45〜59点）**: 【条件付き】共同申請・特定要件を満たせば活用可能
   - **C（44点以下）**: 太良町には不適・対象外（デフォルトでは一覧から除外）
4. **現場目線のペルソナ絞り込み**
   - `👵 福祉・介護・医療` `🍊 みかん・農業` `🦀 カニ・海苔・水産` `♨️ 温泉旅館・観光` `🏪 商店・飲食・小規模` `🏗️ 建設・土木` `🌲 林業・木材` `💻 IT・DX化` `🌱 環境・再エネ` `🏛️ 役場・地域振興`
5. **AIクイック相談ウィジェット**
   - 補助金詳細ページで「うちのデイサービスでリフト買える？」「みかん農家だけど倉庫に使える？」と聞くだけで、Workers AI（Llama 3.1 8B）が公募要領をもとに 1〜2 秒で「⭕️ 使える可能性大 / ⚠️ 条件付き / ❌ 原則対象外」とアドバイスを即答。

---

## アーキテクチャ

```
Cron Trigger (毎日 JST 6:00)
  → jGrants API (国) ＋ sagaperch.jp (佐賀県) から一覧取得
  → D1 に新規保存 (ON CONFLICT DO NOTHING)
  → Queue 投入

Queue Consumer
  → grant.fetch_detail: 詳細HTML取得・省庁名補完 → D1更新
  → grant.analyze: Jev (System One) 適格判定 → Workers AI 構造化要約 → D1保存

Web UI (React SPA)
  → GET /api/grants → ペルソナ・ランク・検索付き一覧
  → GET /api/grants/:id → 詳細 + ひと目でわかる診断カード
  → POST /api/grants/:id/check → AIクイック相談（1秒判定）
```

Cloudflare 完結（Workers + D1 + Queues + Workers AI + Cron Triggers）。
ランニングコストは Cloudflare 無料枠内で実質0円。

---

## スタック

| レイヤー | 技術 |
|---|---|
| **Frontend** | React 19 + TypeScript + Tailwind CSS v4 + TanStack Query + Wouter |
| **Backend** | Hono v4 on Cloudflare Workers |
| **Database** | D1 (SQLite) + Drizzle ORM |
| **Queue / Cron** | Cloudflare Queues + Cron Triggers |
| **AI 推論** | Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/qwen/qwen3.8-27b`, Llama 3.3 70B) ＋ TypeSafe Jev |
| **データソース** | jGrants API (デジタル庁) ＋ 佐賀県産業イノベーションセンター クローラー |
| **Build** | Vite + @cloudflare/vite-plugin |

---

## クイックスタート

```bash
# 依存関係インストール
npm install

# D1マイグレーション (ローカル)
npm run db:migrate

# 開発サーバー起動
npm run dev
```

`http://localhost:5173` でローカル動作を確認できます。

---

## API エンドポイント

| メソッド / パス | 内容 | 認証 |
|---|---|---|
| `GET /api/grants` | 補助金一覧（パラメータ: `rank`, `category`, `q`, `include_ended`） | 不要 |
| `GET /api/grants/:id` | 補助金詳細 + AI解析結果 | 不要 |
| `POST /api/grants/:id/check` | **AIクイック相談**（リクエスト: `{ question: string }`） | 不要（同オリジン） |
| `GET /api/grants/status` | ステータス（収集件数・解析件数・最終Cron日時） | 不要 |
| `POST /api/grants/ingest` | 手動データ取り込みトリガー | `x-admin-secret` 必須 |
| `POST /api/grants/reanalyze` | AI解析の一括再実行トリガー（クエリ: `all=true` で全件） | `x-admin-secret` 必須 |
| `GET /api/health` | ヘルスチェック | 不要 |

---

## ディレクトリ構成

```
tara-grant-scout/
├── app/                          # フロントエンド (React SPA)
│   ├── components/AppShell.tsx   # レイアウト・ヘッダー・フッター
│   ├── hooks/useGrants.ts        # データ取得用 TanStack Query フック
│   └── pages/grants/
│       ├── GrantListPage.tsx     # ペルソナフィルタ付き補助金一覧
│       └── GrantDetailPage.tsx   # 詳細表示・適用診断カード・AI相談ウィジェット
├── src/                          # バックエンド (Cloudflare Workers)
│   ├── db/schema.ts              # Drizzle ORM スキーマ (grants, grant_ai_analyses)
│   ├── features/grants/          # 補助金コア機能
│   │   ├── jgrants-source.ts     # 国 jGrants API クライアント
│   │   ├── sagaperch-source.ts   # 佐賀県産業イノベーションセンター クローラー
│   │   ├── analyzer.ts           # 2段階AI評価エンジン (Jev + Workers AI)
│   │   ├── eligibility-checker.ts# AIクイック相談モジュール
│   │   ├── ingest.ts             # 収集・Queue投入オーケストレータ
│   │   └── tara-profile.ts       # 太良町の産業・過疎計画プロファイル
│   ├── routes/grants.ts          # 補助金 REST API ルーティング
│   └── index.ts                  # Worker エントリ (fetch, scheduled, queue)
├── test/                         # Vitest ユニットテスト
│   ├── analyzer.test.ts          # AI解析パイプラインテスト
│   ├── eligibility.test.ts       # AIクイック相談テスト
│   └── sagaperch.test.ts         # 佐賀県クローラーテスト
└── migrations/                   # D1 マイグレーション SQL
```

---

## デプロイ

```bash
# リモートD1マイグレーション
npm run db:migrate:remote

# ビルド & Cloudflare Workers へのデプロイ
npm run deploy
```

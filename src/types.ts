export interface Env {
  DB: D1Database;
  KV?: KVNamespace;
  JOBS: Queue;
  ASSETS: Fetcher;
  AI: Ai;
  CORS_ORIGIN?: string;
  APP_BASE_URL?: string;
  // 外部LLMはフォールバック用（主モデルは Workers AI）
  KIMI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ADMIN_SECRET: string;
}

export interface IngestJobMessage {
  type: "grant.fetch_detail" | "grant.analyze";
  payload: Record<string, unknown>;
}

export interface AppVariables {
  requestId: string;
}

export type AppContextEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

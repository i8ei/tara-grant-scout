export interface WorkersAiBinding {
  run: <T = unknown>(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<T>;
}

export interface Env {
  DB: D1Database;
  KV?: KVNamespace;
  JOBS: Queue;
  ASSETS: Fetcher;
  AI?: WorkersAiBinding;
  CORS_ORIGIN?: string;
  APP_BASE_URL?: string;
  // 外部LLMはフォールバック用（主モデルは Workers AI）
  KIMI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
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

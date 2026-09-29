import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { AppContextEnv, Env, IngestJobMessage } from "./types";
import health from "./routes/health";
import grantsRoutes from "./routes/grants";
import { csrfProtection } from "./middleware/csrf";
import { rateLimiter } from "./middleware/rate-limit";
import { resolveCorsOrigins } from "./lib/cors";
import { logEvent } from "./lib/logging";
import { requestId } from "./middleware/request-id";
import { jsonError } from "./lib/http";
import { ingestGrantList, handleFetchDetail, handleAnalyze } from "./features/grants/ingest";

export const app = new Hono<AppContextEnv>()
  .use("*", requestId)
  .use("*", logger())
  .use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    })
  )
  .use(
    "/api/*",
    cors({
      origin: (origin, c) => {
        const allowlist = resolveCorsOrigins(c.env);
        if (!origin) return allowlist[0];
        return allowlist.includes(origin) ? origin : "";
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "x-admin-secret"],
    })
  )
  .use("/api/*", rateLimiter)
  .use("/api/*", csrfProtection)
  .onError((err, c) => {
    logEvent("error", "request.error", {
      method: c.req.method,
      path: c.req.path,
      message: err.message,
      requestId: c.get("requestId"),
    });
    return jsonError(c, 500, "internal_error", "Internal Server Error");
  })
  .route("/api/health", health)
  .route("/api/grants", grantsRoutes);

export type AppType = typeof app;

export default {
  fetch: app.fetch,

  /** Cron Trigger — 毎日21:00 UTC (= JST 06:00) に補助金一覧を取得 */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    logEvent("info", "cron.start", { cron: event.cron });
    ctx.waitUntil(
      ingestGrantList(env)
        .then((result) => {
          logEvent("info", "cron.done", result);
        })
        .catch((err) => {
          logEvent("error", "cron.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        })
    );
  },

  /** Queue Consumer — 詳細取得・AI解析ジョブを処理 */
  async queue(batch: MessageBatch<IngestJobMessage>, env: Env) {
    for (const msg of batch.messages) {
      const { type, payload } = msg.body;
      try {
        switch (type) {
          case "grant.fetch_detail":
            await handleFetchDetail(env, payload as { grantId: number; jgrantsId: string });
            break;
          case "grant.analyze":
            await handleAnalyze(env, payload as { grantId: number; force?: boolean });
            break;
          default:
            logEvent("warn", "queue.unknown_type", { type });
        }
        msg.ack();
      } catch (err) {
        logEvent("error", "queue.job_error", {
          type,
          message: err instanceof Error ? err.message : String(err),
        });
        msg.retry();
      }
    }
  },
};

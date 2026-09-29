import { createMiddleware } from "hono/factory";
import type { AppContextEnv } from "../types";
import { resolveCorsOrigins } from "../lib/cors";
import { jsonError } from "../lib/http";
import { logRequestEvent } from "../lib/logging";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isAllowedReferer(referer: string | undefined, allowlist: string[]): boolean {
  if (!referer) return false;
  try {
    return allowlist.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}

export const csrfProtection = createMiddleware<AppContextEnv>(async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  // Admin secret 認証のリクエストはCSRF免除（M2M通信用）
  if (c.req.header("x-admin-secret")) {
    await next();
    return;
  }

  // Validate Origin/Referer for ALL mutating requests, not just those
  // with a session cookie. This prevents login CSRF attacks where an
  // attacker forces a victim to authenticate as the attacker's account.
  const allowlist = [...resolveCorsOrigins(c.env)];
  try {
    const selfOrigin = new URL(c.req.url).origin;
    if (!allowlist.includes(selfOrigin)) {
      allowlist.push(selfOrigin);
    }
  } catch {
    // ignore
  }

  const origin = c.req.header("origin");
  if (origin && allowlist.includes(origin)) {
    await next();
    return;
  }

  if (isAllowedReferer(c.req.header("referer"), allowlist)) {
    await next();
    return;
  }

  logRequestEvent("warn", "security.csrf_rejected", c, {
    origin: origin ?? null,
    referer: c.req.header("referer") ?? null,
  });
  return jsonError(c, 403, "csrf_rejected", "Forbidden");
});

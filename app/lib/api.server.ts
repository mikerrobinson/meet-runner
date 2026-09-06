/**
 * Shared plumbing for the API routes: the database binding, the two response
 * shapes, and the two ways a caller can prove who it is. The syncing itself
 * lives in `sync.server.ts`, and accounts in `auth.server.ts`.
 */

import { bearerToken, userForToken, type User } from "./auth.server";
import type { NotifyEnv } from "./notify.server";

export interface SyncEnv extends NotifyEnv {
  DB?: D1Database;
  SYNC_TOKEN?: string;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof SyncError) {
    return json({ error: error.message }, error.status);
  }
  console.error("Sync failure:", error);
  return json({ error: "Server error" }, 500);
}

/**
 * If SYNC_TOKEN is configured, callers must present it. Without it the
 * endpoints are open — fine for a private worker route, not for a public one.
 */
export function requireAuth(request: Request, env: SyncEnv): void {
  const expected = env.SYNC_TOKEN;
  if (!expected) return;
  if (request.headers.get("x-sync-token") !== expected) {
    throw new SyncError("Sync token missing or incorrect", 401);
  }
}

export function requireDb(env: SyncEnv): D1Database {
  if (!env.DB) {
    throw new SyncError(
      "No D1 database is bound to this worker (expected a binding named DB)",
      503,
    );
  }
  return env.DB;
}

/** Whoever is signed in on this request, or null. */
export async function currentUser(
  request: Request,
  env: SyncEnv,
): Promise<User | null> {
  if (!env.DB) return null;
  return userForToken(env.DB, bearerToken(request));
}

export async function requireUser(request: Request, env: SyncEnv): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new SyncError("Sign in first", 401);
  return user;
}

export async function readJson<T>(request: Request): Promise<T> {
  const body = (await request.json().catch(() => null)) as T | null;
  if (!body || typeof body !== "object") {
    throw new SyncError("Expected a JSON body", 400);
  }
  return body;
}

/**
 * Where the app lives, worked out from the request rather than from anything
 * the caller said.
 *
 * This ends up in an emailed link, so it must not be something a caller can
 * choose — otherwise asking for a code to someone else's address would be a
 * way to send them a link to your own site. The API path is a known suffix, so
 * removing it leaves the base: `/projects/meet-runner/` in production and `/`
 * in dev, with no config to keep in step.
 */
export function appBaseUrl(request: Request): string {
  const url = new URL(request.url);
  const cut = url.pathname.lastIndexOf("/api/");
  const base = cut >= 0 ? url.pathname.slice(0, cut) : "";
  return `${url.origin}${base}/`;
}

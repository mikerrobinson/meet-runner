/**
 * Shared plumbing for the API routes: the shared-secret check, the database
 * binding, and the two response shapes. The syncing itself lives in
 * `sync.server.ts`.
 */

export interface SyncEnv {
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

/**
 * Server side of sync. The whole meet is stored as one JSON blob — it's a few
 * hundred KB at most, only one person edits it, and keeping it as a document
 * means the client and server never disagree about shape.
 */

import { migrateMeet, migrateTeam } from "./documents";
import { currentSeason } from "./roster";
import type { MeetDoc, TeamDoc } from "~/types/meet";

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

let schemaReady = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS meets (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         date TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         data TEXT NOT NULL
       )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS teams (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         season TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         data TEXT NOT NULL
       )`,
    )
    .run();

  // Added after the meets table shipped, so it has to be applied separately.
  // Deployments that already have the column throw here; that's the success
  // case on a second run, not a failure.
  try {
    await db.prepare("ALTER TABLE meets ADD COLUMN team_id TEXT").run();
  } catch {
    /* column already present */
  }

  // Deleting a meet has to be a fact the server stores, not a row that goes
  // missing — see `deletedAt` on MeetDoc.
  try {
    await db.prepare("ALTER TABLE meets ADD COLUMN deleted_at INTEGER").run();
  } catch {
    /* column already present */
  }

  schemaReady = true;
}

export interface MeetSummaryRow {
  id: string;
  name: string;
  date: string;
  updated_at: number;
  deleted_at: number | null;
}

export async function listMeetSummaries(db: D1Database) {
  await ensureSchema(db);
  // Deleted meets are listed too, with their tombstone: a device that already
  // holds a copy learns to drop it, and one that never had it can skip it.
  const { results } = await db
    .prepare(
      "SELECT id, name, date, updated_at, deleted_at FROM meets ORDER BY updated_at DESC LIMIT 50",
    )
    .all<MeetSummaryRow>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    date: row.date,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }));
}

export async function getMeet(
  db: D1Database,
  id: string,
): Promise<MeetDoc | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT data FROM meets WHERE id = ?")
    .bind(id)
    .first<{ data: string }>();
  if (!row) return null;
  try {
    return migrateMeet(JSON.parse(row.data));
  } catch {
    throw new SyncError("Stored meet is corrupt", 500);
  }
}

/**
 * Last-write-wins on `updatedAt`. A stale push is rejected rather than applied,
 * so an old tab left open on another device can't clobber the live copy.
 */
export async function putMeet(
  db: D1Database,
  incoming: MeetDoc,
): Promise<{ updatedAt: number; applied: boolean }> {
  await ensureSchema(db);

  const existing = await db
    .prepare("SELECT updated_at FROM meets WHERE id = ?")
    .bind(incoming.id)
    .first<{ updated_at: number }>();

  if (existing && existing.updated_at > incoming.updatedAt) {
    return { updatedAt: existing.updated_at, applied: false };
  }

  await db
    .prepare(
      `INSERT INTO meets (id, name, date, team_id, updated_at, deleted_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         date = excluded.date,
         team_id = excluded.team_id,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         data = excluded.data`,
    )
    .bind(
      incoming.id,
      incoming.name,
      incoming.date,
      incoming.teamId,
      incoming.updatedAt,
      incoming.deletedAt ?? null,
      JSON.stringify(incoming),
    )
    .run();

  return { updatedAt: incoming.updatedAt, applied: true };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SyncError("Request body wasn't valid JSON", 400);
  }
}

export async function parseMeetBody(request: Request): Promise<MeetDoc> {
  const meet = migrateMeet(await readJson(request));
  if (!meet) throw new SyncError("Request body isn't a meet document", 400);
  return meet;
}

export async function parseTeamBody(request: Request): Promise<TeamDoc> {
  const team = migrateTeam(await readJson(request));
  if (!team) throw new SyncError("Request body isn't a team document", 400);
  return team;
}

/* -------------------------------------------------------------------- team */

function parseTeamRow(data: string): TeamDoc | null {
  try {
    return migrateTeam(JSON.parse(data));
  } catch {
    throw new SyncError("Stored team is corrupt", 500);
  }
}

/**
 * The season's team.
 *
 * There should only ever be one row. More than one means some device minted
 * its own team instead of adopting the season already here — in which case the
 * newest row is usually the *empty* one it just created, so recency is exactly
 * the wrong tiebreak. Decide by what the data says instead: whichever team the
 * meets actually belong to, then whichever has a roster at all, and only then
 * the most recently touched.
 */
export async function getTeam(db: D1Database): Promise<TeamDoc | null> {
  await ensureSchema(db);

  const { results } = await db
    .prepare("SELECT id, updated_at, data FROM teams")
    .all<{ id: string; updated_at: number; data: string }>();

  if (results.length === 0) return null;
  if (results.length === 1) return parseTeamRow(results[0].data);

  const { results: meetCounts } = await db
    .prepare(
      "SELECT team_id, COUNT(*) AS n FROM meets WHERE team_id IS NOT NULL GROUP BY team_id",
    )
    .all<{ team_id: string; n: number }>();
  const byTeam = new Map(meetCounts.map((row) => [row.team_id, row.n] as const));

  const ranked = results
    .map((row) => {
      const team = parseTeamRow(row.data);
      return {
        team,
        meets: byTeam.get(row.id) ?? 0,
        swimmers: team?.swimmers.length ?? 0,
        updatedAt: row.updated_at,
      };
    })
    .sort(
      (a, b) =>
        b.meets - a.meets ||
        b.swimmers - a.swimmers ||
        b.updatedAt - a.updatedAt,
    );

  return ranked[0].team;
}

/** Same last-write-wins rule as meets: a stale push is rejected, not applied. */
export async function putTeam(
  db: D1Database,
  incoming: TeamDoc,
): Promise<{ updatedAt: number; applied: boolean }> {
  await ensureSchema(db);

  const existing = await db
    .prepare("SELECT updated_at FROM teams WHERE id = ?")
    .bind(incoming.id)
    .first<{ updated_at: number }>();

  if (existing && existing.updated_at > incoming.updatedAt) {
    return { updatedAt: existing.updated_at, applied: false };
  }

  await db
    .prepare(
      `INSERT INTO teams (id, name, season, updated_at, data)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         season = excluded.season,
         updated_at = excluded.updated_at,
         data = excluded.data`,
    )
    .bind(
      incoming.id,
      incoming.name,
      currentSeason(incoming)?.name ?? "",
      incoming.updatedAt,
      JSON.stringify(incoming),
    )
    .run();

  return { updatedAt: incoming.updatedAt, applied: true };
}

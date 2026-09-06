/**
 * Object storage and the sync endpoint's engine.
 *
 * One table holds every kind of object. That's deliberate: the sync query is
 * "everything for this team since T", and answering it from one indexed table
 * beats a union across ten. The columns we actually filter on — team and meet
 * — are real columns rather than buried in the JSON, so those queries use an
 * index instead of scanning.
 */

import { migrateMeet, migrateTeam } from "./documents";
import { toObjects, type SyncObject } from "./objects";
import type { MeetDoc, TeamDoc } from "~/types/meet";

/**
 * `updated_at` is the editing device's clock and decides who wins a contest
 * for the same object. `server_at` is ours, and is what a cursor pages
 * through — a device's clock being wrong shouldn't be able to hide a change
 * from everyone else.
 *
 * The primary key is (type, id) because ids are only unique within a type: a
 * meet and its lineup share the meet's id on purpose.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS objects (
     id TEXT NOT NULL,
     type TEXT NOT NULL,
     team_id TEXT NOT NULL,
     meet_id TEXT,
     updated_at INTEGER NOT NULL,
     server_at INTEGER NOT NULL,
     deleted_at INTEGER,
     data TEXT NOT NULL,
     PRIMARY KEY (type, id)
   )`,
  `CREATE INDEX IF NOT EXISTS objects_cursor ON objects (team_id, server_at)`,
  `CREATE INDEX IF NOT EXISTS objects_by_meet ON objects (meet_id, server_at)`,
];

let ready = false;

export async function ensureObjectStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

/** Which meet an object belongs to, where that means anything. */
function meetIdOf(object: SyncObject): string | null {
  const data = object.data as { meetId?: string } | null;
  if (object.type === "meet" || object.type === "lineup") return object.id;
  return data?.meetId ?? null;
}

export interface PushResult {
  /** Objects the server took. */
  applied: number;
  /** Objects refused because the stored copy is newer, with that copy. */
  refused: SyncObject[];
}

/**
 * Take a batch of objects.
 *
 * Per object, newest edit wins — which is the whole point of the split. Two
 * devices working the same meet touch different objects and both land; only a
 * genuine contest over one object has a loser, and that loser is told.
 */
export async function pushObjects(
  db: D1Database,
  incoming: SyncObject[],
): Promise<PushResult> {
  await ensureObjectStore(db);
  if (incoming.length === 0) return { applied: 0, refused: [] };

  const serverAt = Date.now();
  const accepted = new Set<string>();

  // Written in batches: a first sync carries thousands of objects, and D1
  // allows only so many statements and bound values per round trip.
  for (let start = 0; start < incoming.length; start += CHUNK) {
    const slice = incoming.slice(start, start + CHUNK);
    const results = await db.batch<{ type: string; id: string }>(
      slice.map((object) =>
        db
          .prepare(
            `INSERT INTO objects (id, type, team_id, meet_id, updated_at, server_at, deleted_at, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(type, id) DO UPDATE SET
               team_id = excluded.team_id,
               meet_id = excluded.meet_id,
               updated_at = excluded.updated_at,
               server_at = excluded.server_at,
               deleted_at = excluded.deleted_at,
               data = excluded.data
             WHERE excluded.updated_at >= objects.updated_at
             RETURNING type, id`,
          )
          .bind(
            object.id,
            object.type,
            object.teamId,
            meetIdOf(object),
            object.updatedAt,
            serverAt,
            object.deletedAt ?? null,
            JSON.stringify(object.data),
          ),
      ),
    );

    // Nothing comes back for a row the WHERE rejected: the stored copy was
    // edited more recently, so this one loses and the sender is told.
    for (const result of results) {
      for (const row of result.results ?? []) {
        accepted.add(`${row.type}:${row.id}`);
      }
    }
  }

  const lost = incoming.filter((o) => !accepted.has(`${o.type}:${o.id}`));
  return {
    applied: incoming.length - lost.length,
    refused: await fetchObjects(db, lost),
  };
}

/**
 * Objects per round trip. Each carries eight bound values, and D1 allows a
 * hundred per query — so this is about batch size rather than binding.
 */
const CHUNK = 50;

/** The stored copies of objects a push lost to, so the sender can reconcile. */
async function fetchObjects(
  db: D1Database,
  wanted: SyncObject[],
): Promise<SyncObject[]> {
  if (wanted.length === 0) return [];

  const found: SyncObject[] = [];
  // Two bound values each, kept well inside D1's limit of a hundred.
  for (let start = 0; start < wanted.length; start += 40) {
    const slice = wanted.slice(start, start + 40);
    const { results } = await db
      .prepare(
        `SELECT id, type, team_id, updated_at, server_at, deleted_at, data
         FROM objects WHERE (type, id) IN (VALUES ${slice.map(() => "(?, ?)").join(", ")})`,
      )
      .bind(...slice.flatMap((o) => [o.type, o.id]))
      .all<StoredRow>();
    found.push(...results.map(rowToObject));
  }
  return found;
}

interface StoredRow {
  id: string;
  type: string;
  team_id: string;
  updated_at: number;
  server_at: number;
  deleted_at: number | null;
  data: string;
}

function rowToObject(row: StoredRow): SyncObject {
  return {
    id: row.id,
    type: row.type as SyncObject["type"],
    teamId: row.team_id,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    data: JSON.parse(row.data),
  };
}

export interface PullResult {
  changes: SyncObject[];
  /** Opaque cursor to send next time. */
  cursor: string;
  /** True when the page was capped and there's more waiting. */
  more: boolean;
}

/** How many objects one page of changes carries. A full season is ~17,000. */
const PAGE = 500;

/**
 * Where a pull left off: a position in (server_at, type, id) order.
 *
 * A timestamp alone isn't enough. A batch of writes shares a millisecond, and
 * if more of them share it than fit in one page, a timestamp cursor can never
 * advance past the group — the same page comes back forever and a first sync
 * never finishes. Including the key breaks the tie.
 */
interface Cursor {
  at: number;
  type: string;
  id: string;
}

function parseCursor(raw: string | number | null | undefined): Cursor {
  if (typeof raw === "number") return { at: raw, type: "", id: "" };
  const [at, type = "", id = ""] = String(raw ?? "").split("|");
  const parsed = Number(at);
  return { at: Number.isFinite(parsed) ? parsed : 0, type, id };
}

function formatCursor(row: StoredRow): string {
  return `${row.server_at}|${row.type}|${row.id}`;
}

/** Everything for a team that changed after a cursor. */
export async function pullObjects(
  db: D1Database,
  teamId: string,
  rawCursor: string | number | null | undefined,
): Promise<PullResult> {
  await ensureObjectStore(db);
  const from = parseCursor(rawCursor);

  const { results } = await db
    .prepare(
      `SELECT id, type, team_id, updated_at, server_at, deleted_at, data
       FROM objects
       WHERE team_id = ?
         AND (server_at > ?
              OR (server_at = ? AND (type > ? OR (type = ? AND id > ?))))
       ORDER BY server_at, type, id
       LIMIT ?`,
    )
    .bind(teamId, from.at, from.at, from.type, from.type, from.id, PAGE + 1)
    .all<StoredRow>();

  const more = results.length > PAGE;
  const page = more ? results.slice(0, PAGE) : results;

  return {
    changes: page.map(rowToObject),
    // Resume from the last row actually sent, so nothing is skipped or repeated.
    cursor:
      page.length > 0
        ? formatCursor(page[page.length - 1])
        : `${from.at}|${from.type}|${from.id}`,
    more,
  };
}

export interface TeamChoice {
  id: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
  times: number;
  updatedAt: number;
}

/**
 * The teams the object store knows about, with enough detail to tell them
 * apart.
 *
 * Read from the objects rather than the old documents table, which stopped
 * being the truth the moment syncing moved to objects — a device adopting
 * from it would take on a season frozen at conversion time.
 */
export async function listTeamChoices(db: D1Database): Promise<TeamChoice[]> {
  await ensureObjectStore(db);

  const { results } = await db
    .prepare(
      `SELECT team_id,
              SUM(CASE WHEN type = 'athlete' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS athletes,
              SUM(CASE WHEN type = 'meet'    AND deleted_at IS NULL THEN 1 ELSE 0 END) AS meets,
              SUM(CASE WHEN type = 'watch'   AND deleted_at IS NULL THEN 1 ELSE 0 END) AS times,
              MAX(updated_at) AS updated_at
       FROM objects GROUP BY team_id`,
    )
    .all<{
      team_id: string;
      athletes: number;
      meets: number;
      times: number;
      updated_at: number;
    }>();

  const { results: names } = await db
    .prepare(
      "SELECT id, data FROM objects WHERE type = 'team' AND deleted_at IS NULL",
    )
    .all<{ id: string; data: string }>();
  const byId = new Map(
    names.map((r) => [r.id, JSON.parse(r.data) as { name: string; code: string }]),
  );

  return results
    .filter((row) => byId.has(row.team_id))
    .map((row) => ({
      id: row.team_id,
      name: byId.get(row.team_id)!.name,
      code: byId.get(row.team_id)!.code ?? "",
      athletes: row.athletes,
      meets: row.meets,
      times: row.times,
      updatedAt: row.updated_at,
    }))
    .sort((a, b) => b.times - a.times || b.meets - a.meets);
}

/**
 * Fill the object store from the old document tables, once.
 *
 * A straight conversion rather than a compatibility layer: the documents are
 * read, decomposed, and written as objects, and after that nothing reads the
 * old tables. They're left in place as a fallback until the next deploy
 * proves this out.
 */
export async function convertDocuments(
  db: D1Database,
): Promise<{ teams: number; meets: number; objects: number }> {
  await ensureObjectStore(db);

  const { results: teamRows } = await db
    .prepare("SELECT data FROM teams")
    .all<{ data: string }>();
  const { results: meetRows } = await db
    .prepare("SELECT data FROM meets")
    .all<{ data: string }>();

  const teams = teamRows
    .map((r) => migrateTeam(JSON.parse(r.data)))
    .filter((t): t is TeamDoc => t !== null);
  const meets = meetRows
    .map((r) => migrateMeet(JSON.parse(r.data)))
    .filter((m): m is MeetDoc => m !== null);

  let objects = 0;
  for (const team of teams) {
    const mine = meets.filter((m) => m.teamId === team.id);
    const batch = toObjects(team, mine);
    await pushObjects(db, batch);
    objects += batch.length;
  }

  return { teams: teams.length, meets: meets.length, objects };
}

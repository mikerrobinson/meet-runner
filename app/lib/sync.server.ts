/**
 * Object storage and the sync endpoint's engine.
 *
 * One table holds every kind of object. That's deliberate: the sync query is
 * "everything in these scopes since T", and answering it from one indexed
 * table beats a union across ten. The scope is a real column rather than
 * buried in the JSON, so that query uses an index instead of scanning.
 */

import { scopeKey, type ObjectScope, type SyncObject } from "./objects";

/**
 * `updated_at` is the editing device's clock and decides who wins a contest
 * for the same object. `server_at` is ours, and is what a cursor pages
 * through — a device's clock being wrong shouldn't be able to hide a change
 * from everyone else.
 *
 * The primary key is (type, id) because ids are only unique within a type: a
 * meet and its lineup share the meet's id on purpose.
 *
 * `scope` is the flattened form of an `ObjectScope` — "team:abc", "meet:def",
 * or "global". One column and one index, because every question the sync
 * engine asks is an exact match on it.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS objects (
     id TEXT NOT NULL,
     type TEXT NOT NULL,
     scope TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     server_at INTEGER NOT NULL,
     deleted_at INTEGER,
     data TEXT NOT NULL,
     PRIMARY KEY (type, id)
   )`,
  `CREATE INDEX IF NOT EXISTS objects_cursor ON objects (scope, server_at)`,
];

let ready = false;

export async function ensureObjectStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
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
            `INSERT INTO objects (id, type, scope, updated_at, server_at, deleted_at, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(type, id) DO UPDATE SET
               scope = excluded.scope,
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
            scopeKey(object.scope),
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
 * Objects per round trip. Each carries seven bound values, and D1 allows a
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
        `SELECT id, type, scope, updated_at, server_at, deleted_at, data
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
  scope: string;
  updated_at: number;
  server_at: number;
  deleted_at: number | null;
  data: string;
}

function parseScope(raw: string): ObjectScope {
  if (raw === "global") return { kind: "global" };
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  return kind === "meet" ? { kind: "meet", id } : { kind: "team", id };
}

function rowToObject(row: StoredRow): SyncObject {
  return {
    id: row.id,
    type: row.type as SyncObject["type"],
    scope: parseScope(row.scope),
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

/**
 * Everything in a set of scopes that changed after a cursor.
 *
 * A device asks for what it's actually working on: its team, the meets it
 * holds, and `global` for the people those reference. One cursor covers the
 * lot, because the ordering is over the whole result rather than per scope.
 */
export async function pullObjects(
  db: D1Database,
  scopes: ObjectScope[],
  rawCursor: string | number | null | undefined,
): Promise<PullResult> {
  await ensureObjectStore(db);
  const from = parseCursor(rawCursor);

  const keys = [...new Set(scopes.map(scopeKey))];
  if (keys.length === 0) {
    return { changes: [], cursor: `${from.at}|${from.type}|${from.id}`, more: false };
  }

  const { results } = await db
    .prepare(
      `SELECT id, type, scope, updated_at, server_at, deleted_at, data
       FROM objects
       WHERE scope IN (${keys.map(() => "?").join(", ")})
         AND (server_at > ?
              OR (server_at = ? AND (type > ? OR (type = ? AND id > ?))))
       ORDER BY server_at, type, id
       LIMIT ?`,
    )
    .bind(...keys, from.at, from.at, from.type, from.type, from.id, PAGE + 1)
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

/**
 * Every meet a team is racing in.
 *
 * Read from the meets themselves rather than from a column, because a meet
 * names its teams and belongs to none of them — there is nothing to group by.
 */
export async function meetIdsFor(
  db: D1Database,
  teamId: string,
): Promise<string[]> {
  await ensureObjectStore(db);
  const { results } = await db
    .prepare("SELECT id, data FROM objects WHERE type = 'meet'")
    .all<{ id: string; data: string }>();

  return results
    .filter((row) => {
      const meet = JSON.parse(row.data) as { teamIds?: string[] };
      return meet.teamIds?.includes(teamId) ?? false;
    })
    .map((row) => row.id);
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
 * Counted through enrollments and meet references rather than by grouping on a
 * team column, which no longer exists — an athlete belongs to no team, and a
 * meet belongs to all of the ones racing it.
 */
export async function listTeamChoices(db: D1Database): Promise<TeamChoice[]> {
  await ensureObjectStore(db);

  const { results: rows } = await db
    .prepare(
      `SELECT id, type, scope, updated_at, data FROM objects
       WHERE deleted_at IS NULL AND type IN ('team', 'enrollment', 'meet', 'watch')`,
    )
    .all<{
      id: string;
      type: string;
      scope: string;
      updated_at: number;
      data: string;
    }>();

  const teams = new Map<string, { name: string; code: string; updatedAt: number }>();
  const enrolled = new Map<string, Set<string>>();
  const meetTeams = new Map<string, string[]>();
  const watchesPerMeet = new Map<string, number>();

  for (const row of rows) {
    const scope = parseScope(row.scope);
    if (row.type === "team") {
      const data = JSON.parse(row.data) as { name?: string; code?: string };
      teams.set(row.id, {
        name: data.name ?? "Team",
        code: data.code ?? "",
        updatedAt: row.updated_at,
      });
    } else if (row.type === "enrollment" && scope.kind === "team") {
      const data = JSON.parse(row.data) as { athleteId?: string };
      if (data.athleteId) {
        (enrolled.get(scope.id) ?? enrolled.set(scope.id, new Set()).get(scope.id)!).add(
          data.athleteId,
        );
      }
    } else if (row.type === "meet") {
      const data = JSON.parse(row.data) as { teamIds?: string[] };
      meetTeams.set(row.id, data.teamIds ?? []);
    } else if (row.type === "watch" && scope.kind === "meet") {
      watchesPerMeet.set(scope.id, (watchesPerMeet.get(scope.id) ?? 0) + 1);
    }
  }

  return [...teams.entries()]
    .map(([id, team]) => {
      const meets = [...meetTeams.entries()].filter(([, ids]) => ids.includes(id));
      return {
        id,
        name: team.name,
        code: team.code,
        athletes: enrolled.get(id)?.size ?? 0,
        meets: meets.length,
        times: meets.reduce(
          (total, [meetId]) => total + (watchesPerMeet.get(meetId) ?? 0),
          0,
        ),
        updatedAt: team.updatedAt,
      };
    })
    .sort((a, b) => b.times - a.times || b.meets - a.meets);
}

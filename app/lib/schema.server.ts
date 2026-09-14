/**
 * The database, as tables.
 *
 * One table per thing, columns for its fields, foreign keys by id. There is no
 * object store, no scope column, no per-row `updated_at` deciding who wins a
 * merge, and no tombstones — the server is the source of truth, a row is
 * written by whoever owns it, and a delete is a DELETE.
 *
 * Two shapes are worth knowing before reading the rest.
 *
 * **`meet_id` is denormalised onto events, entries and heats.** It is derivable
 * by joining, and it's here anyway because every screen under a meet asks
 * "everything for this meet" and D1 answers that fastest as a handful of
 * indexed single-table reads.
 *
 * **Rows several people write at once are keyed so they can't collide.** A
 * seat is `(heat_id, lane)`, a watch is `(heat_id, lane, timer_id)`, a call is
 * `(heat_id, lane)`. Six timers seating their own lane write six different
 * rows; three timers on one lane write three different rows. Concurrency is a
 * property of the keys rather than something the app has to reconcile
 * afterwards.
 *
 * The account tables — users, identities, sessions, memberships, invites — are
 * defined in `auth.server.ts` and unchanged; meet grants in `grants.server.ts`,
 * meet administrators in `admins.server.ts`.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     code TEXT NOT NULL,
     current_season_id TEXT,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS seasons (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     name TEXT NOT NULL,
     start_date TEXT,
     end_date TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS seasons_by_team ON seasons (team_id)`,

  /**
   * People. Global, and never deleted — results reference them by id forever.
   */
  `CREATE TABLE IF NOT EXISTS athletes (
     id TEXT PRIMARY KEY,
     first_name TEXT NOT NULL,
     last_name TEXT NOT NULL,
     gender TEXT NOT NULL,
     birth_date TEXT,
     user_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS athletes_by_user ON athletes (user_id)`,
  `CREATE INDEX IF NOT EXISTS athletes_by_name ON athletes (last_name, first_name)`,

  /**
   * Who swam for a team, and when. The roster is this table, not a column on
   * the team: one person can be enrolled by a school and a club at once.
   */
  `CREATE TABLE IF NOT EXISTS enrollments (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     season_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     year TEXT NOT NULL DEFAULT '',
     squad TEXT,
     status TEXT NOT NULL DEFAULT 'active'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS enrollments_unique ON enrollments (season_id, athlete_id)`,
  `CREATE INDEX IF NOT EXISTS enrollments_by_team ON enrollments (team_id)`,
  `CREATE INDEX IF NOT EXISTS enrollments_by_athlete ON enrollments (athlete_id)`,

  `CREATE TABLE IF NOT EXISTS meets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     date TEXT NOT NULL,
     type TEXT NOT NULL,
     course TEXT NOT NULL,
     location TEXT,
     host_team_id TEXT,
     created_by TEXT,
     lane_count INTEGER NOT NULL DEFAULT 6,
     lead_gender TEXT NOT NULL DEFAULT 'F',
     include_diving INTEGER NOT NULL DEFAULT 0,
     entry_visibility TEXT NOT NULL DEFAULT 'everyone',
     athletes_may_enter INTEGER NOT NULL DEFAULT 0,
     max_individual INTEGER,
     max_relays INTEGER,
     max_total INTEGER,
     max_per_team_per_event INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS meets_by_date ON meets (date)`,

  /** Which teams are racing. A meet belongs to none of them. */
  `CREATE TABLE IF NOT EXISTS meet_teams (
     meet_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     PRIMARY KEY (meet_id, team_id)
   )`,
  `CREATE INDEX IF NOT EXISTS meet_teams_by_team ON meet_teams (team_id)`,

  /**
   * The programme. `position` is the order events are swum in, so reordering
   * is an update to a column rather than a rewrite of a list.
   */
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     distance INTEGER NOT NULL,
     stroke TEXT NOT NULL,
     gender TEXT NOT NULL,
     name TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS events_by_meet ON events (meet_id, position)`,

  /** One swimmer in one race. Two coaches entering their own never collide. */
  `CREATE TABLE IF NOT EXISTS entries (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     PRIMARY KEY (event_id, athlete_id)
   )`,
  `CREATE INDEX IF NOT EXISTS entries_by_meet ON entries (meet_id)`,
  `CREATE INDEX IF NOT EXISTS entries_by_athlete ON entries (athlete_id)`,

  `CREATE TABLE IF NOT EXISTS heats (
     id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     lane_count INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS heats_by_meet ON heats (meet_id)`,
  `CREATE INDEX IF NOT EXISTS heats_by_event ON heats (event_id, idx)`,

  /**
   * Who is in a lane — the single answer to that question, whoever writes it.
   * Keyed by lane, so six timers seating their own lane write six rows.
   */
  `CREATE TABLE IF NOT EXISTS seats (
     meet_id TEXT NOT NULL,
     heat_id TEXT NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT NOT NULL,
     PRIMARY KEY (heat_id, lane)
   )`,
  `CREATE INDEX IF NOT EXISTS seats_by_meet ON seats (meet_id)`,

  /**
   * Evidence. One row per timer per lane, so an extra watch never overwrites
   * anybody and a re-send is an update rather than a duplicate.
   */
  `CREATE TABLE IF NOT EXISTS watches (
     meet_id TEXT NOT NULL,
     heat_id TEXT NOT NULL,
     lane INTEGER NOT NULL,
     timer_id TEXT NOT NULL,
     time_ms INTEGER NOT NULL,
     source TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     started_at INTEGER,
     stopped_at INTEGER,
     PRIMARY KEY (heat_id, lane, timer_id)
   )`,
  `CREATE INDEX IF NOT EXISTS watches_by_meet ON watches (meet_id)`,

  /**
   * The decision. One row per lane, replacing what used to be a ruling and an
   * acceptance written on the same tap. `final` is the sign-off; `time_ms` is
   * the official's own reading and survives taking the sign-off back.
   */
  `CREATE TABLE IF NOT EXISTS calls (
     meet_id TEXT NOT NULL,
     heat_id TEXT NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT,
     status TEXT NOT NULL DEFAULT 'OK',
     time_ms INTEGER,
     final INTEGER NOT NULL DEFAULT 0,
     decided_by TEXT,
     decided_at INTEGER NOT NULL,
     from_time_ms INTEGER,
     from_watch_count INTEGER,
     from_method TEXT,
     PRIMARY KEY (heat_id, lane)
   )`,
  `CREATE INDEX IF NOT EXISTS calls_by_meet ON calls (meet_id)`,
];

let ready = false;

/**
 * Create anything missing, once per worker instance.
 *
 * Cheap enough to call from any loader — after the first call it's a boolean
 * check — and it means a fresh database or a new deployment needs no separate
 * migration step to start working.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

/** For tests and scripts that want the statements without the memoisation. */
export const SCHEMA_STATEMENTS = SCHEMA;

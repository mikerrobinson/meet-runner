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
 * seat is `(heat, lane)`, a watch is `(heat, lane, timer_id)`, a call is
 * `(heat, lane)`. Six timers seating their own lane write six different
 * rows; three timers on one lane write three different rows. Concurrency is a
 * property of the keys rather than something the app has to reconcile
 * afterwards.
 *
 * The account tables — users, identities, sessions, invites — are defined in
 * `auth.server.ts`; meet grants in `grants.server.ts`, and who runs what in
 * `admins.server.ts` (meets) and `coaches.server.ts` (teams).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     code TEXT NOT NULL,
     current_season_id TEXT,
     created_by TEXT,
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
     timers_per_lane INTEGER NOT NULL DEFAULT 1,
     lead_gender TEXT NOT NULL DEFAULT 'F',
     include_diving INTEGER NOT NULL DEFAULT 0,
     entry_visibility TEXT NOT NULL DEFAULT 'everyone',
     athletes_may_enter INTEGER NOT NULL DEFAULT 0,
     max_individual INTEGER,
     max_relays INTEGER,
     max_total INTEGER,
     max_per_team_per_event INTEGER,
     lane_assignments TEXT,
     scoring TEXT,
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

  /**
   * One planned swim. The unit everything about running a meet hangs off.
   *
   * There is no heats table: a heat is which heat, a small integer, so the
   * heats of an event are the distinct heats across its seeds and a heat
   * cannot exist with nothing in it. Keyed by event, heat and lane, so the
   * coach seeding, the administrator correcting the desk and the timer fixing
   * a name behind the blocks all write the same row and the last wins.
   *
   * The `id` is what lets a time survive somebody being moved: watches and
   * results point at it, not at a lane number.
   */
  `CREATE TABLE IF NOT EXISTS seeds (
     id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     heat INTEGER NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT NOT NULL,
     seed_time_ms INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS seeds_by_meet ON seeds (meet_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS seeds_by_lane ON seeds (event_id, heat, lane)`,

  /**
   * Evidence. One row per submitter per swim, so an extra watch never
   * overwrites anybody and a re-send is an update rather than a duplicate.
   *
   * `time_ms` is null while a stopwatch is running and nothing has been
   * submitted — which is how the desk tells a lane nobody is covering from one
   * whose timers are still holding their clocks.
   */
  `CREATE TABLE IF NOT EXISTS watches (
     seed_id TEXT NOT NULL,
     meet_id TEXT NOT NULL,
     timer_id TEXT NOT NULL,
     user_id TEXT,
     role TEXT NOT NULL DEFAULT 'timer',
     time_ms INTEGER,
     recorded_at INTEGER NOT NULL,
     started_at INTEGER,
     stopped_at INTEGER,
     PRIMARY KEY (seed_id, timer_id)
   )`,
  `CREATE INDEX IF NOT EXISTS watches_by_meet ON watches (meet_id)`,

  /**
   * The official outcome of one swim, written only by an administrator.
   *
   * Its existence *is* the sign-off — there is no flag, because a row that
   * isn't signed off is a row that isn't there, and taking it back is deleting
   * it. The accepted number is written straight in, so a late watch or a
   * discarded one cannot move a result after the fact.
   */
  `CREATE TABLE IF NOT EXISTS results (
     seed_id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'OK',
     time_ms INTEGER NOT NULL,
     decided_by TEXT,
     decided_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS results_by_meet ON results (meet_id)`,
  `CREATE INDEX IF NOT EXISTS results_by_event ON results (event_id)`,
];

/**
 * Columns added to a table that already exists somewhere.
 *
 * `CREATE TABLE IF NOT EXISTS` is the whole of the schema above, which is
 * exactly right for a new database and does nothing at all for the one
 * already holding a season's meets. So a column added later is stated twice:
 * in the table, for a database being created now, and here, for one that
 * isn't. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the second run of one
 * of these fails with "duplicate column name" — which is the success case,
 * and the only error swallowed below.
 *
 * Deliberately not a migration framework. There is no version table and no
 * ordering to get wrong: each statement is idempotent on its own, and a list
 * of them is as much machinery as adding a column to a handful of rows is
 * worth.
 */
const MIGRATIONS = [
  `ALTER TABLE meets ADD COLUMN timers_per_lane INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE meets ADD COLUMN lane_assignments TEXT`,
  `ALTER TABLE meets ADD COLUMN scoring TEXT`,
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
  for (const statement of MIGRATIONS) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      // Already applied — which is what this looks like every time but the
      // first. Anything else is a real failure and belongs in the logs.
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  ready = true;
}

/** For tests and scripts that want the statements without the memoisation. */
export const SCHEMA_STATEMENTS = SCHEMA;

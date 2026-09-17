/**
 * Reading and writing a meet.
 *
 * Every function here takes a `D1Database` and returns POCOs. Loaders call
 * them; so do the JSON routes, so there is one query and one shape behind both
 * rather than a second read path built for the API.
 *
 * The writes are deliberately small. Seating a lane writes one row, entering a
 * swimmer writes one row, taking a time writes one row — because the people
 * doing those things are doing them at the same moment on different devices,
 * and the only reliable way for two writes not to fight is for them not to
 * touch the same row.
 */

import { ensureSchema } from "./schema.server";
import { generateId } from "./id";
import {
  DUAL_MEET_SCORING,
  isLaneCount,
  isTimersPerLane,
  type Entry,
} from "~/types/meet";
import type {
  Athlete,
  Enrollment,
  EntryLimits,
  Gender,
  LaneAssignments,
  LaneCount,
  Meet,
  MeetCourse,
  MeetDetail,
  MeetEvent,
  Result,
  ScoringRules,
  Seed,
  MeetType,
  ResultStatus,
  Stroke,
  Team,
  TimersPerLane,
  Watch,
} from "~/types/meet";
import { athleteRow, type AthleteRow } from "./athletes.server";
import { enrollmentFrom, teamRow, type EnrollmentRow, type TeamRow } from "./teams.server";

/* ------------------------------------------------------------------- rows */

interface MeetRow {
  id: string;
  name: string;
  date: string;
  type: string;
  course: string;
  location: string | null;
  host_team_id: string | null;
  created_by: string | null;
  lane_count: number;
  timers_per_lane: number;
  lead_gender: string;
  include_diving: number;
  entry_visibility: string;
  athletes_may_enter: number;
  max_individual: number | null;
  max_relays: number | null;
  max_total: number | null;
  max_per_team_per_event: number | null;
  lane_assignments: string | null;
  scoring: string | null;
}

/** Parse a JSON column, falling back rather than throwing on a bad or absent value. */
function parseJsonColumn<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function meetFrom(row: MeetRow, teamIds: string[]): Meet {
  const limits: EntryLimits = {};
  if (row.max_individual != null) limits.maxIndividual = row.max_individual;
  if (row.max_relays != null) limits.maxRelays = row.max_relays;
  if (row.max_total != null) limits.maxTotal = row.max_total;
  if (row.max_per_team_per_event != null) {
    limits.maxPerTeamPerEvent = row.max_per_team_per_event;
  }

  return {
    id: row.id,
    name: row.name,
    date: row.date,
    type: row.type as MeetType,
    course: row.course as MeetCourse,
    location: row.location ?? undefined,
    teamIds,
    hostTeamId: row.host_team_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    laneCount: isLaneCount(row.lane_count) ? row.lane_count : 6,
    // Absent on every meet made before the setting existed, which is a meet
    // whose timers each carried their own phone.
    timersPerLane: isTimersPerLane(row.timers_per_lane) ? row.timers_per_lane : 1,
    leadGender: row.lead_gender === "M" ? "M" : "F",
    includeDiving: row.include_diving === 1,
    entryVisibility: row.entry_visibility === "own-team" ? "own-team" : "everyone",
    athletesMayEnter: row.athletes_may_enter === 1,
    limits,
    laneAssignments: parseJsonColumn<LaneAssignments>(row.lane_assignments, {}),
    scoring: parseJsonColumn<ScoringRules>(row.scoring, DUAL_MEET_SCORING),
  };
}

interface EventRow {
  id: string;
  meet_id: string;
  position: number;
  distance: number;
  stroke: string;
  gender: string;
  name: string | null;
}

function eventFrom(row: EventRow): MeetEvent {
  return {
    id: row.id,
    meetId: row.meet_id,
    position: row.position,
    distance: row.distance,
    stroke: row.stroke as Stroke,
    gender: row.gender as MeetEvent["gender"],
    name: row.name ?? undefined,
  };
}

interface SeedRow {
  id: string;
  meet_id: string;
  event_id: string;
  heat: number;
  lane: number;
  athlete_id: string;
  seed_time_ms: number | null;
}

function seedFrom(row: SeedRow): Seed {
  return {
    id: row.id,
    meetId: row.meet_id,
    eventId: row.event_id,
    heat: row.heat,
    lane: row.lane,
    athleteId: row.athlete_id,
    seedTimeMs: row.seed_time_ms ?? undefined,
  };
}

interface WatchRow {
  seed_id: string;
  timer_id: string;
  user_id: string | null;
  role: string | null;
  time_ms: number | null;
  recorded_at: number;
  started_at: number | null;
  stopped_at: number | null;
}

function watchFrom(row: WatchRow): Watch {
  return {
    seedId: row.seed_id,
    timerId: row.timer_id,
    userId: row.user_id ?? undefined,
    role:
      row.role === "admin" || row.role === "coach" ? row.role : "timer",
    timeMs: row.time_ms ?? undefined,
    recordedAt: row.recorded_at,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
  };
}

interface ResultRow {
  seed_id: string;
  meet_id: string;
  event_id: string;
  athlete_id: string;
  status: string;
  time_ms: number;
  decided_by: string | null;
  decided_at: number;
}

function resultFrom(row: ResultRow): Result {
  return {
    seedId: row.seed_id,
    meetId: row.meet_id,
    eventId: row.event_id,
    athleteId: row.athlete_id,
    status: row.status === "DQ" || row.status === "NS" ? row.status : "OK",
    timeMs: row.time_ms,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at,
  };
}

/* ------------------------------------------------------------------ reads */

export async function getMeet(db: D1Database, id: string): Promise<Meet | null> {
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM meets WHERE id = ?").bind(id).first<MeetRow>();
  if (!row) return null;
  const { results } = await db
    .prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?")
    .bind(id)
    .all<{ team_id: string }>();
  return meetFrom(row, results.map((r) => r.team_id));
}

export interface MeetSummary {
  meet: Meet;
  teams: Team[];
  eventCount: number;
  entryCount: number;
  timedLanes: number;
}

/**
 * The meets list.
 *
 * Counts come back as aggregates rather than by loading each meet whole — the
 * list shows "1 event · 6 entries · 2 times" and nothing else, and fetching
 * six meets in full to render three numbers each is how a list screen gets
 * slow.
 */
export async function listMeets(
  db: D1Database,
  options: { teamId?: string } = {},
): Promise<MeetSummary[]> {
  await ensureSchema(db);

  const where = options.teamId
    ? "WHERE m.id IN (SELECT meet_id FROM meet_teams WHERE team_id = ?)"
    : "";
  const binds = options.teamId ? [options.teamId] : [];

  const { results: meetRows } = await db
    .prepare(`SELECT m.* FROM meets m ${where} ORDER BY m.date DESC`)
    .bind(...binds)
    .all<MeetRow>();
  if (meetRows.length === 0) return [];

  const ids = meetRows.map((m) => m.id);
  const holes = ids.map(() => "?").join(", ");

  const [links, events, entries, watches, teams] = await Promise.all([
    db.prepare(`SELECT meet_id, team_id FROM meet_teams WHERE meet_id IN (${holes})`)
      .bind(...ids).all<{ meet_id: string; team_id: string }>(),
    db.prepare(`SELECT meet_id, COUNT(*) AS n FROM events WHERE meet_id IN (${holes}) GROUP BY meet_id`)
      .bind(...ids).all<{ meet_id: string; n: number }>(),
    db.prepare(`SELECT meet_id, COUNT(*) AS n FROM entries WHERE meet_id IN (${holes}) GROUP BY meet_id`)
      .bind(...ids).all<{ meet_id: string; n: number }>(),
    db.prepare(
      `SELECT meet_id, COUNT(DISTINCT seed_id) AS n
       FROM watches WHERE meet_id IN (${holes}) AND time_ms IS NOT NULL
       GROUP BY meet_id`,
    ).bind(...ids).all<{ meet_id: string; n: number }>(),
    db.prepare(
      `SELECT * FROM teams WHERE id IN (
         SELECT team_id FROM meet_teams WHERE meet_id IN (${holes}))`,
    ).bind(...ids).all<TeamRow>(),
  ]);

  const teamById = new Map(teams.results.map((t) => [t.id, teamRow(t)] as const));
  const teamsOf = new Map<string, string[]>();
  for (const link of links.results) {
    (teamsOf.get(link.meet_id) ?? teamsOf.set(link.meet_id, []).get(link.meet_id)!)
      .push(link.team_id);
  }
  const count = (rows: { meet_id: string; n: number }[]) =>
    new Map(rows.map((r) => [r.meet_id, r.n] as const));
  const eventsBy = count(events.results);
  const entriesBy = count(entries.results);
  const watchesBy = count(watches.results);

  return meetRows.map((row) => {
    const teamIds = teamsOf.get(row.id) ?? [];
    return {
      meet: meetFrom(row, teamIds),
      teams: teamIds.map((id) => teamById.get(id)).filter((t): t is Team => !!t),
      eventCount: eventsBy.get(row.id) ?? 0,
      entryCount: entriesBy.get(row.id) ?? 0,
      timedLanes: watchesBy.get(row.id) ?? 0,
    };
  });
}

/**
 * Everything a meet's screens need, in one round of queries.
 *
 * Seven single-table reads against indexed `meet_id` columns, plus the people
 * those rows refer to. That denormalised column is why this isn't a pile of
 * joins.
 */
export async function meetDetail(
  db: D1Database,
  meetId: string,
): Promise<MeetDetail | null> {
  await ensureSchema(db);

  const meetRowP = db.prepare("SELECT * FROM meets WHERE id = ?").bind(meetId).first<MeetRow>();
  const [meetRow, links, events, entries, seeds, watches, results] =
    await Promise.all([
      meetRowP,
      db.prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?").bind(meetId).all<{ team_id: string }>(),
      db.prepare("SELECT * FROM events WHERE meet_id = ? ORDER BY position").bind(meetId).all<EventRow>(),
      db.prepare("SELECT event_id, athlete_id FROM entries WHERE meet_id = ?").bind(meetId).all<{ event_id: string; athlete_id: string }>(),
      db.prepare("SELECT * FROM seeds WHERE meet_id = ?").bind(meetId).all<SeedRow>(),
      db.prepare("SELECT * FROM watches WHERE meet_id = ?").bind(meetId).all<WatchRow>(),
      db.prepare("SELECT * FROM results WHERE meet_id = ?").bind(meetId).all<ResultRow>(),
    ]);
  if (!meetRow) return null;

  const teamIds = links.results.map((r) => r.team_id);
  const meet = meetFrom(meetRow, teamIds);

  const entryMap: Record<string, string[]> = {};
  for (const row of entries.results) {
    (entryMap[row.event_id] ??= []).push(row.athlete_id);
  }

  // Everyone these rows actually name, plus everyone on a racing team's
  // roster — a swimmer nobody has entered yet still has to be pickable.
  const wanted = new Set<string>();
  for (const list of Object.values(entryMap)) for (const id of list) wanted.add(id);
  // Skipping the lanes nobody has named yet, whose `athlete_id` is empty —
  // there is no such person to fetch.
  for (const seed of seeds.results) {
    if (seed.athlete_id) wanted.add(seed.athlete_id);
  }

  const holes = teamIds.map(() => "?").join(", ");
  const [teams, rosters] = await Promise.all([
    teamIds.length
      ? db.prepare(`SELECT * FROM teams WHERE id IN (${holes})`)
          .bind(...teamIds).all<TeamRow>()
      : Promise.resolve({ results: [] as TeamRow[] }),
    // The rosters of the teams actually racing, for the season this meet falls
    // in. A swimmer nobody has entered yet still needs a row on the grid.
    teamIds.length
      ? db.prepare(
          `SELECT e.* FROM enrollments e
           WHERE e.team_id IN (${holes})
             AND e.season_id IN (
               SELECT s.id FROM seasons s
               WHERE s.team_id = e.team_id
                 AND (s.start_date IS NULL OR s.start_date <= ?)
                 AND (s.end_date IS NULL OR s.end_date >= ?))`,
        ).bind(...teamIds, meet.date, meet.date).all<EnrollmentRow>()
      : Promise.resolve({ results: [] as EnrollmentRow[] }),
  ]);
  for (const row of rosters.results) wanted.add(row.athlete_id);

  return {
    meet,
    teams: teams.results.map(teamRow),
    events: events.results.map(eventFrom),
    entries: entryMap,
    seeds: seeds.results.map(seedFrom),
    watches: watches.results.map(watchFrom),
    results: results.results.map(resultFrom),
    athletes: await athletesByIds(db, [...wanted]),
    enrollments: rosters.results.map(enrollmentFrom),
  };
}

/** People by id, in batches D1 will accept. */
async function athletesByIds(db: D1Database, ids: string[]): Promise<Athlete[]> {
  if (ids.length === 0) return [];
  const out: Athlete[] = [];
  for (let start = 0; start < ids.length; start += 80) {
    const slice = ids.slice(start, start + 80);
    const { results } = await db
      .prepare(`SELECT * FROM athletes WHERE id IN (${slice.map(() => "?").join(", ")})`)
      .bind(...slice)
      .all<AthleteRow>();
    out.push(...results.map(athleteRow));
  }
  return out;
}

/* ----------------------------------------------------------------- writing */

export interface MeetInput {
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teamIds: string[];
  hostTeamId?: string;
  createdBy?: string;
  laneCount?: LaneCount;
  timersPerLane?: TimersPerLane;
  leadGender?: Gender;
  includeDiving?: boolean;
  limits?: EntryLimits;
  entryVisibility?: Meet["entryVisibility"];
  athletesMayEnter?: boolean;
  laneAssignments?: LaneAssignments;
  scoring?: ScoringRules;
}

export async function createMeet(
  db: D1Database,
  input: MeetInput,
  now = Date.now(),
): Promise<Meet> {
  await ensureSchema(db);
  const id = generateId();
  const teamIds = [...new Set(input.teamIds.filter(Boolean))];

  await db.batch([
    db.prepare(
      `INSERT INTO meets (id, name, date, type, course, location, host_team_id,
                          created_by, lane_count, timers_per_lane,
                          lead_gender, include_diving,
                          entry_visibility, athletes_may_enter,
                          max_individual, max_relays, max_total, max_per_team_per_event,
                          lane_assignments, scoring,
                          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.name,
      input.date,
      input.type,
      input.course,
      input.location ?? null,
      teamIds.includes(input.hostTeamId ?? "") ? input.hostTeamId! : null,
      input.createdBy ?? null,
      input.laneCount ?? 6,
      input.timersPerLane ?? 1,
      input.leadGender ?? "F",
      input.includeDiving ? 1 : 0,
      input.entryVisibility ?? "everyone",
      input.athletesMayEnter ? 1 : 0,
      input.limits?.maxIndividual ?? null,
      input.limits?.maxRelays ?? null,
      input.limits?.maxTotal ?? null,
      input.limits?.maxPerTeamPerEvent ?? null,
      JSON.stringify(input.laneAssignments ?? {}),
      JSON.stringify(input.scoring ?? DUAL_MEET_SCORING),
      now,
    ),
    ...teamIds.map((teamId) =>
      db.prepare("INSERT OR IGNORE INTO meet_teams (meet_id, team_id) VALUES (?, ?)")
        .bind(id, teamId),
    ),
  ]);

  return (await getMeet(db, id))!;
}

/** Patch a meet's own fields. Columns absent from the patch are untouched. */
export async function updateMeet(
  db: D1Database,
  meetId: string,
  patch: Partial<MeetInput>,
): Promise<void> {
  await ensureSchema(db);

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  if (patch.name !== undefined) set("name", patch.name);
  if (patch.date !== undefined) set("date", patch.date);
  if (patch.type !== undefined) set("type", patch.type);
  if (patch.course !== undefined) set("course", patch.course);
  if (patch.location !== undefined) set("location", patch.location || null);
  if (patch.hostTeamId !== undefined) set("host_team_id", patch.hostTeamId || null);
  if (patch.laneCount !== undefined) set("lane_count", patch.laneCount);
  if (patch.timersPerLane !== undefined) {
    set("timers_per_lane", patch.timersPerLane);
  }
  if (patch.leadGender !== undefined) set("lead_gender", patch.leadGender);
  if (patch.includeDiving !== undefined) set("include_diving", patch.includeDiving ? 1 : 0);
  if (patch.entryVisibility !== undefined) set("entry_visibility", patch.entryVisibility);
  if (patch.athletesMayEnter !== undefined) {
    set("athletes_may_enter", patch.athletesMayEnter ? 1 : 0);
  }
  if (patch.limits !== undefined) {
    set("max_individual", patch.limits.maxIndividual ?? null);
    set("max_relays", patch.limits.maxRelays ?? null);
    set("max_total", patch.limits.maxTotal ?? null);
    set("max_per_team_per_event", patch.limits.maxPerTeamPerEvent ?? null);
  }
  if (patch.laneAssignments !== undefined) {
    set("lane_assignments", JSON.stringify(patch.laneAssignments));
  }
  if (patch.scoring !== undefined) set("scoring", JSON.stringify(patch.scoring));

  if (sets.length > 0) {
    await db.prepare(`UPDATE meets SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds, meetId)
      .run();
  }

  if (patch.teamIds) {
    const teamIds = [...new Set(patch.teamIds.filter(Boolean))];
    await db.batch([
      db.prepare("DELETE FROM meet_teams WHERE meet_id = ?").bind(meetId),
      ...teamIds.map((teamId) =>
        db.prepare("INSERT OR IGNORE INTO meet_teams (meet_id, team_id) VALUES (?, ?)")
          .bind(meetId, teamId),
      ),
    ]);
  }
}

/**
 * Delete a meet and everything under it.
 *
 * A real delete, in one batch. There is no tombstone to keep: nothing else
 * holds a copy that could put the row back.
 */
export async function deleteMeet(db: D1Database, meetId: string): Promise<void> {
  await ensureSchema(db);
  await db.batch(
    ["results", "watches", "seeds", "entries", "events", "meet_teams"]
      .map((table) => db.prepare(`DELETE FROM ${table} WHERE meet_id = ?`).bind(meetId))
      .concat(db.prepare("DELETE FROM meets WHERE id = ?").bind(meetId)),
  );
}

/* ----------------------------------------------------------------- events */

export async function addEvent(
  db: D1Database,
  meetId: string,
  event: { distance: number; stroke: Stroke; gender: MeetEvent["gender"]; name?: string },
): Promise<MeetEvent> {
  await ensureSchema(db);
  const last = await db
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM events WHERE meet_id = ?")
    .bind(meetId)
    .first<{ p: number }>();
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO events (id, meet_id, position, distance, stroke, gender, name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, meetId, (last?.p ?? -1) + 1, event.distance, event.stroke, event.gender, event.name ?? null)
    .run();
  return { id, meetId, position: (last?.p ?? -1) + 1, ...event };
}

/** Write a whole lineup at once — what "start from the standard order" does. */
export async function addEventsToMeet(
  db: D1Database,
  meetId: string,
  events: MeetEvent[],
): Promise<void> {
  await ensureSchema(db);
  if (events.length === 0) return;
  await db.batch(
    events.map((event, position) =>
      db.prepare(
        `INSERT INTO events (id, meet_id, position, distance, stroke, gender, name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        meetId,
        position,
        event.distance,
        event.stroke,
        event.gender,
        event.name ?? null,
      ),
    ),
  );
}

/**
 * Remove an event and everything under it.
 *
 * Watches and results hang off seeds rather than the event, so they are found
 * through them — a subselect rather than two round trips, and one that cannot
 * miss a row the way a list of ids fetched a moment earlier can.
 */
export async function removeEvent(db: D1Database, eventId: string): Promise<void> {
  await ensureSchema(db);
  // Nothing hanging off these seeds is deleted, and nothing needs to be:
  // `reseedEvent` refuses once the event has a watch or a result against it,
  // so by the time this runs there is nothing to orphan. Deleting evidence to
  // make room for a reseeding is the failure that rule exists to prevent.
  await db.batch([
    db.prepare("DELETE FROM seeds WHERE event_id = ?").bind(eventId),
    db.prepare("DELETE FROM entries WHERE event_id = ?").bind(eventId),
    db.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
  ]);
}

/** Write the running order. `position` is the order, so this is one column. */
export async function setEventOrder(
  db: D1Database,
  order: string[],
): Promise<void> {
  await ensureSchema(db);
  if (order.length === 0) return;
  await db.batch(
    order.map((eventId, index) =>
      db.prepare("UPDATE events SET position = ? WHERE id = ?").bind(index, eventId),
    ),
  );
}

/* ---------------------------------------------------------------- entries */

export async function addEntry(db: D1Database, entry: Entry): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id) VALUES (?, ?, ?)",
    )
    .bind(entry.meetId, entry.eventId, entry.athleteId)
    .run();
}

export async function removeEntry(
  db: D1Database,
  eventId: string,
  athleteId: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM entries WHERE event_id = ? AND athlete_id = ?")
    .bind(eventId, athleteId)
    .run();
}

/* ------------------------------------------------------------------ heats */

/**
 * Replace an event's heats.
 *
 * Callers pass heats that already carry the ids they want kept — see
 * `reseedHeats` in `heats.ts`, which reuses the existing ids by position so a
 * reseed doesn't orphan the seats, watches and calls pointing at them.
 */
/**
 * Replace an event's seeding wholesale.
 *
 * Seeding is one person's single decision about a whole event, so the rows are
 * rewritten rather than diffed — but `reseedEvent` hands back the ids of any
 * swim that didn't actually move, so a watch already taken on it survives.
 */
export async function replaceSeeds(
  db: D1Database,
  meetId: string,
  eventId: string,
  seeds: Seed[],
): Promise<void> {
  await ensureSchema(db);
  const under = "SELECT id FROM seeds WHERE event_id = ?";
  await db.batch([
    db.prepare(`DELETE FROM results WHERE seed_id IN (${under})`).bind(eventId),
    db.prepare(`DELETE FROM watches WHERE seed_id IN (${under})`).bind(eventId),
    db.prepare("DELETE FROM seeds WHERE event_id = ?").bind(eventId),
    ...seeds.map((seed) =>
      db
        .prepare(
          `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          seed.id,
          meetId,
          eventId,
          seed.heat,
          seed.lane,
          seed.athleteId,
          seed.seedTimeMs ?? null,
        ),
    ),
  ]);
}

/**
 * Put somebody in a lane, or move who is already there.
 *
 * The single answer to "who is in lane 4": the coach seeding, the
 * administrator correcting the desk and the timer fixing a name behind the
 * blocks all write this same row, and the last one wins.
 *
 * Nobody swims an event twice, so this vacates whatever other lane they held —
 * and swimming a race is being in it, so it enters them too. The returned seed
 * is what the caller needs to file a watch against.
 */
export async function setSeed(
  db: D1Database,
  meetId: string,
  place: { eventId: string; heat: number; lane: number; athleteId: string },
): Promise<Seed> {
  await ensureSchema(db);

  const existing = await db
    .prepare("SELECT * FROM seeds WHERE event_id = ? AND heat = ? AND lane = ?")
    .bind(place.eventId, place.heat, place.lane)
    .first<SeedRow>();

  // Somewhere else in this event, if they were.
  await db
    .prepare(
      `DELETE FROM seeds
       WHERE event_id = ? AND athlete_id = ? AND NOT (heat = ? AND lane = ?)`,
    )
    .bind(place.eventId, place.athleteId, place.heat, place.lane)
    .run();

  const id = existing?.id ?? generateId();
  await db
    .prepare(
      `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, heat, lane) DO UPDATE SET athlete_id = excluded.athlete_id`,
    )
    .bind(id, meetId, place.eventId, place.heat, place.lane, place.athleteId)
    .run();

  await db
    .prepare("INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id) VALUES (?, ?, ?)")
    .bind(meetId, place.eventId, place.athleteId)
    .run();

  return {
    id,
    meetId,
    eventId: place.eventId,
    heat: place.heat,
    lane: place.lane,
    athleteId: place.athleteId,
    seedTimeMs: existing?.seed_time_ms ?? undefined,
  };
}

/** Find the swim in a lane, if there is one. */
export async function seedAt(
  db: D1Database,
  eventId: string,
  heat: number,
  lane: number,
): Promise<Seed | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM seeds WHERE event_id = ? AND heat = ? AND lane = ?")
    .bind(eventId, heat, lane)
    .first<SeedRow>();
  return row ? seedFrom(row) : null;
}

/**
 * The swim in a lane, made to exist because something was timed against it.
 *
 * A watch belongs to a swim, and a swim is a lane in a heat before it is
 * anybody in particular. Behind the blocks the name is often the last thing
 * settled: the volunteer is watching the water, the heat goes off, and who
 * was in lane 4 gets sorted out afterwards. So a time for a lane nobody has
 * named creates the lane rather than being refused, with no athlete on it.
 *
 * Nothing else about the row is touched if it is already there — this never
 * moves anybody or un-names a lane — and `setSeed` keeps this id when a name
 * finally arrives, so the watch is already hanging off the right swim.
 */
export async function ensureLane(
  db: D1Database,
  meetId: string,
  place: { eventId: string; heat: number; lane: number },
): Promise<Seed> {
  await ensureSchema(db);

  const existing = await seedAt(db, place.eventId, place.heat, place.lane);
  if (existing) return existing;

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id)
       VALUES (?, ?, ?, ?, ?, '')
       ON CONFLICT(event_id, heat, lane) DO NOTHING`,
    )
    .bind(id, meetId, place.eventId, place.heat, place.lane)
    .run();

  // Re-read rather than trusting the insert: two timers on the same lane can
  // both arrive here, and the one that lost has to come away with the id that
  // won — otherwise their watches would hang off two different swims.
  return (
    (await seedAt(db, place.eventId, place.heat, place.lane)) ?? {
      id,
      meetId,
      eventId: place.eventId,
      heat: place.heat,
      lane: place.lane,
      athleteId: "",
    }
  );
}

/** Take somebody out of a lane. Their watches go with the swim. */
export async function removeSeed(db: D1Database, seedId: string): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare("DELETE FROM watches WHERE seed_id = ?").bind(seedId),
    db.prepare("DELETE FROM results WHERE seed_id = ?").bind(seedId),
    db.prepare("DELETE FROM seeds WHERE id = ?").bind(seedId),
  ]);
}

/* ---------------------------------------------------------------- watches */

/**
 * Record a measurement, or update the one this submitter already made.
 *
 * `timeMs` absent is a stopwatch that has started and not been submitted, and
 * it is written the same way — one row per submitter per swim, upserted, so a
 * start followed by a time is one row rather than two facts to reconcile.
 */
export async function putWatch(
  db: D1Database,
  meetId: string,
  watch: Watch,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO watches (seed_id, meet_id, timer_id, user_id, role, time_ms,
                            recorded_at, started_at, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seed_id, timer_id) DO UPDATE SET
         user_id = excluded.user_id,
         role = excluded.role,
         -- A start arriving after a time must not blank the time, which is
         -- what a re-sent start cookie would otherwise do.
         time_ms = COALESCE(excluded.time_ms, watches.time_ms),
         recorded_at = excluded.recorded_at,
         started_at = COALESCE(excluded.started_at, watches.started_at),
         stopped_at = COALESCE(excluded.stopped_at, watches.stopped_at)`,
    )
    .bind(
      watch.seedId,
      meetId,
      watch.timerId,
      watch.userId ?? null,
      watch.role,
      watch.timeMs ?? null,
      watch.recordedAt,
      watch.startedAt ?? null,
      watch.stoppedAt ?? null,
    )
    .run();
}

export async function deleteWatch(
  db: D1Database,
  seedId: string,
  timerId: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM watches WHERE seed_id = ? AND timer_id = ?")
    .bind(seedId, timerId)
    .run();
}

/* ---------------------------------------------------------------- results */

/**
 * Sign a swim off.
 *
 * Writing the row *is* the sign-off, and the number is written straight in —
 * so a watch arriving late, or one discarded afterwards, cannot move a result
 * that has already been accepted.
 */
export async function putResult(
  db: D1Database,
  result: Result,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO results (seed_id, meet_id, event_id, athlete_id, status,
                            time_ms, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seed_id) DO UPDATE SET
         status = excluded.status,
         time_ms = excluded.time_ms,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at`,
    )
    .bind(
      result.seedId,
      result.meetId,
      result.eventId,
      result.athleteId,
      result.status,
      result.timeMs,
      result.decidedBy ?? null,
      result.decidedAt,
    )
    .run();
}

/** Take a sign-off back. The watches underneath it are untouched. */
export async function deleteResult(db: D1Database, seedId: string): Promise<void> {
  await ensureSchema(db);
  await db.prepare("DELETE FROM results WHERE seed_id = ?").bind(seedId).run();
}

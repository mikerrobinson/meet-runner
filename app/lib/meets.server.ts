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
import { isLaneCount, type Entry } from "~/types/meet";
import type {
  Athlete,
  Enrollment,
  EntryLimits,
  Gender,
  Heat,
  LaneCall,
  LaneCount,
  Meet,
  MeetCourse,
  MeetDetail,
  MeetEvent,
  MeetType,
  ResultStatus,
  Seat,
  Stroke,
  Team,
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
  lead_gender: string;
  include_diving: number;
  entry_visibility: string;
  athletes_may_enter: number;
  max_individual: number | null;
  max_relays: number | null;
  max_total: number | null;
  max_per_team_per_event: number | null;
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
    leadGender: row.lead_gender === "M" ? "M" : "F",
    includeDiving: row.include_diving === 1,
    entryVisibility: row.entry_visibility === "own-team" ? "own-team" : "everyone",
    athletesMayEnter: row.athletes_may_enter === 1,
    limits,
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

interface HeatRow {
  id: string;
  meet_id: string;
  event_id: string;
  idx: number;
  lane_count: number;
}

interface SeatRow {
  heat_id: string;
  lane: number;
  athlete_id: string;
}

interface WatchRow {
  heat_id: string;
  lane: number;
  timer_id: string;
  time_ms: number;
  source: string;
  recorded_at: number;
  started_at: number | null;
  stopped_at: number | null;
}

function watchFrom(row: WatchRow): Watch {
  return {
    heatId: row.heat_id,
    lane: row.lane,
    timerId: row.timer_id,
    timeMs: row.time_ms,
    source: row.source === "typed" ? "typed" : "stopwatch",
    recordedAt: row.recorded_at,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
  };
}

interface CallRow {
  heat_id: string;
  lane: number;
  athlete_id: string | null;
  status: string;
  time_ms: number | null;
  final: number;
  decided_by: string | null;
  decided_at: number;
  from_time_ms: number | null;
  from_watch_count: number | null;
  from_method: string | null;
}

function callFrom(row: CallRow): LaneCall {
  return {
    heatId: row.heat_id,
    lane: row.lane,
    athleteId: row.athlete_id ?? undefined,
    status: row.status as ResultStatus,
    timeMs: row.time_ms ?? undefined,
    final: row.final === 1,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at,
    ...(row.from_time_ms != null
      ? {
          fromWatches: {
            timeMs: row.from_time_ms,
            watchCount: row.from_watch_count ?? 0,
            method: (row.from_method ?? "official") as LaneCall["status"] extends never
              ? never
              : NonNullable<LaneCall["fromWatches"]>["method"],
          },
        }
      : {}),
  };
}

/**
 * Rebuild a heat's lanes from its seats.
 *
 * The lanes are an array because that's what every screen wants to read, and
 * separate rows because that's what several people writing at once need. This
 * is the one place the two meet.
 */
function heatsFrom(rows: HeatRow[], seats: SeatRow[]): Heat[] {
  const heats = rows.map((row) => ({
    id: row.id,
    meetId: row.meet_id,
    eventId: row.event_id,
    index: row.idx,
    lanes: Array.from({ length: row.lane_count }, () => null as string | null),
  }));
  const byId = new Map(heats.map((h) => [h.id, h] as const));
  for (const seat of seats) {
    const heat = byId.get(seat.heat_id);
    // A seat naming a lane the heat doesn't have is not information.
    if (heat && seat.lane >= 1 && seat.lane <= heat.lanes.length) {
      heat.lanes[seat.lane - 1] = seat.athlete_id;
    }
  }
  return heats.sort((a, b) => a.eventId.localeCompare(b.eventId) || a.index - b.index);
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
      `SELECT meet_id, COUNT(DISTINCT heat_id || ':' || lane) AS n
       FROM watches WHERE meet_id IN (${holes}) GROUP BY meet_id`,
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
  const [meetRow, links, events, entries, heats, seats, watches, calls] =
    await Promise.all([
      meetRowP,
      db.prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?").bind(meetId).all<{ team_id: string }>(),
      db.prepare("SELECT * FROM events WHERE meet_id = ? ORDER BY position").bind(meetId).all<EventRow>(),
      db.prepare("SELECT event_id, athlete_id FROM entries WHERE meet_id = ?").bind(meetId).all<{ event_id: string; athlete_id: string }>(),
      db.prepare("SELECT * FROM heats WHERE meet_id = ?").bind(meetId).all<HeatRow>(),
      db.prepare("SELECT heat_id, lane, athlete_id FROM seats WHERE meet_id = ?").bind(meetId).all<SeatRow>(),
      db.prepare("SELECT * FROM watches WHERE meet_id = ?").bind(meetId).all<WatchRow>(),
      db.prepare("SELECT * FROM calls WHERE meet_id = ?").bind(meetId).all<CallRow>(),
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
  for (const seat of seats.results) wanted.add(seat.athlete_id);
  for (const call of calls.results) if (call.athlete_id) wanted.add(call.athlete_id);

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
    heats: heatsFrom(heats.results, seats.results),
    watches: watches.results.map(watchFrom),
    calls: calls.results.map(callFrom),
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
  leadGender?: Gender;
  includeDiving?: boolean;
  limits?: EntryLimits;
  entryVisibility?: Meet["entryVisibility"];
  athletesMayEnter?: boolean;
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
                          created_by, lane_count, lead_gender, include_diving,
                          entry_visibility, athletes_may_enter,
                          max_individual, max_relays, max_total, max_per_team_per_event,
                          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.leadGender ?? "F",
      input.includeDiving ? 1 : 0,
      input.entryVisibility ?? "everyone",
      input.athletesMayEnter ? 1 : 0,
      input.limits?.maxIndividual ?? null,
      input.limits?.maxRelays ?? null,
      input.limits?.maxTotal ?? null,
      input.limits?.maxPerTeamPerEvent ?? null,
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
    ["calls", "watches", "seats", "heats", "entries", "events", "meet_teams"]
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

export async function removeEvent(db: D1Database, eventId: string): Promise<void> {
  await ensureSchema(db);
  const { results } = await db
    .prepare("SELECT id FROM heats WHERE event_id = ?")
    .bind(eventId)
    .all<{ id: string }>();
  const heatIds = results.map((r) => r.id);
  const holes = heatIds.map(() => "?").join(", ");
  await db.batch([
    ...(heatIds.length
      ? [
          db.prepare(`DELETE FROM calls WHERE heat_id IN (${holes})`).bind(...heatIds),
          db.prepare(`DELETE FROM watches WHERE heat_id IN (${holes})`).bind(...heatIds),
          db.prepare(`DELETE FROM seats WHERE heat_id IN (${holes})`).bind(...heatIds),
        ]
      : []),
    db.prepare("DELETE FROM heats WHERE event_id = ?").bind(eventId),
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
export async function replaceHeats(
  db: D1Database,
  meetId: string,
  eventId: string,
  heats: Heat[],
): Promise<void> {
  await ensureSchema(db);
  const { results } = await db
    .prepare("SELECT id FROM heats WHERE event_id = ?")
    .bind(eventId)
    .all<{ id: string }>();
  const going = results.map((r) => r.id).filter((id) => !heats.some((h) => h.id === id));
  const holes = going.map(() => "?").join(", ");

  await db.batch([
    ...(going.length
      ? [
          db.prepare(`DELETE FROM calls WHERE heat_id IN (${holes})`).bind(...going),
          db.prepare(`DELETE FROM watches WHERE heat_id IN (${holes})`).bind(...going),
          db.prepare(`DELETE FROM seats WHERE heat_id IN (${holes})`).bind(...going),
          db.prepare(`DELETE FROM heats WHERE id IN (${holes})`).bind(...going),
        ]
      : []),
    // Seats are rewritten wholesale for the heats being (re)built, because
    // seeding is one person's single decision about the whole event.
    ...heats.map((heat) =>
      db.prepare("DELETE FROM seats WHERE heat_id = ?").bind(heat.id),
    ),
    ...heats.map((heat) =>
      db.prepare(
        `INSERT INTO heats (id, meet_id, event_id, idx, lane_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET idx = excluded.idx, lane_count = excluded.lane_count`,
      ).bind(heat.id, meetId, eventId, heat.index, heat.lanes.length),
    ),
    ...heats.flatMap((heat) =>
      heat.lanes.flatMap((athleteId, i) =>
        athleteId
          ? [
              db.prepare(
                "INSERT INTO seats (meet_id, heat_id, lane, athlete_id) VALUES (?, ?, ?, ?)",
              ).bind(meetId, heat.id, i + 1, athleteId),
            ]
          : [],
      ),
    ),
  ]);
}

/* ------------------------------------------------------------------ seats */

/**
 * Put a swimmer in a lane.
 *
 * Also vacates whatever other lane of the same event they held — nobody swims
 * an event twice — and enters them in the event if they weren't, because
 * swimming a race is being in it.
 */
export async function setSeat(
  db: D1Database,
  meetId: string,
  seat: Seat,
): Promise<void> {
  await ensureSchema(db);
  const heat = await db
    .prepare("SELECT event_id, lane_count FROM heats WHERE id = ?")
    .bind(seat.heatId)
    .first<{ event_id: string; lane_count: number }>();
  if (!heat) return;
  if (seat.lane < 1 || seat.lane > heat.lane_count) return;

  await db.batch([
    db.prepare(
      `DELETE FROM seats WHERE athlete_id = ? AND heat_id IN
         (SELECT id FROM heats WHERE event_id = ?)`,
    ).bind(seat.athleteId, heat.event_id),
    db.prepare(
      `INSERT INTO seats (meet_id, heat_id, lane, athlete_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(heat_id, lane) DO UPDATE SET athlete_id = excluded.athlete_id`,
    ).bind(meetId, seat.heatId, seat.lane, seat.athleteId),
    db.prepare(
      "INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id) VALUES (?, ?, ?)",
    ).bind(meetId, heat.event_id, seat.athleteId),
  ]);
}

export async function clearSeat(
  db: D1Database,
  heatId: string,
  lane: number,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM seats WHERE heat_id = ? AND lane = ?")
    .bind(heatId, lane)
    .run();
}

/* ---------------------------------------------------------------- watches */

export async function putWatch(
  db: D1Database,
  meetId: string,
  watch: Watch,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO watches (meet_id, heat_id, lane, timer_id, time_ms, source,
                            recorded_at, started_at, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(heat_id, lane, timer_id) DO UPDATE SET
         time_ms = excluded.time_ms,
         source = excluded.source,
         recorded_at = excluded.recorded_at,
         started_at = excluded.started_at,
         stopped_at = excluded.stopped_at`,
    )
    .bind(
      meetId,
      watch.heatId,
      watch.lane,
      watch.timerId,
      watch.timeMs,
      watch.source,
      watch.recordedAt,
      watch.startedAt ?? null,
      watch.stoppedAt ?? null,
    )
    .run();
}

export async function deleteWatch(
  db: D1Database,
  heatId: string,
  lane: number,
  timerId: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM watches WHERE heat_id = ? AND lane = ? AND timer_id = ?")
    .bind(heatId, lane, timerId)
    .run();
}

/**
 * Drop one device's watches for a heat — a false start, or starting again.
 *
 * Scoped to the timer on purpose. A device may discard its own evidence; it
 * may not discard anybody else's, which is a decision and belongs at the desk.
 */
export async function clearOwnWatches(
  db: D1Database,
  heatId: string,
  timerId: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM watches WHERE heat_id = ? AND timer_id = ?")
    .bind(heatId, timerId)
    .run();
}

/* ------------------------------------------------------------------ calls */

export async function putCall(
  db: D1Database,
  meetId: string,
  call: LaneCall,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO calls (meet_id, heat_id, lane, athlete_id, status, time_ms, final,
                          decided_by, decided_at, from_time_ms, from_watch_count, from_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(heat_id, lane) DO UPDATE SET
         athlete_id = excluded.athlete_id,
         status = excluded.status,
         time_ms = excluded.time_ms,
         final = excluded.final,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at,
         from_time_ms = excluded.from_time_ms,
         from_watch_count = excluded.from_watch_count,
         from_method = excluded.from_method`,
    )
    .bind(
      meetId,
      call.heatId,
      call.lane,
      call.athleteId ?? null,
      call.status,
      call.timeMs ?? null,
      call.final ? 1 : 0,
      call.decidedBy ?? null,
      call.decidedAt,
      call.fromWatches?.timeMs ?? null,
      call.fromWatches?.watchCount ?? null,
      call.fromWatches?.method ?? null,
    )
    .run();
}

export async function deleteCall(
  db: D1Database,
  heatId: string,
  lane: number,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM calls WHERE heat_id = ? AND lane = ?")
    .bind(heatId, lane)
    .run();
}

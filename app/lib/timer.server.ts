/**
 * What a timer's phone is allowed to know.
 *
 * Deliberately not the season. A device that scanned a QR code taped to a
 * timing table gets one meet's running order, its lanes, the names needed to
 * fill the picker, and its own times — and nothing else. No birth dates, no
 * other meets, no other timers' watches.
 *
 * It's a projection of `meetDetail` rather than a second assembly of the same
 * rows. There used to be a hand-written copy of the heat/seat join in here,
 * and a second copy of the seating rule; both have gone, which is most of the
 * point of moving the timer onto the same tables as everything else.
 */

import { meetDetail } from "./meets.server";
import { ensureSchema } from "./schema.server";
import type { Grant } from "./grants.server";
import type { Heat, MeetEvent, Watch } from "~/types/meet";

/** A team as a timer needs it: something to tap, and an id to send back. */
export interface TimerTeam {
  id: string;
  name: string;
}

/** A person as a timer needs them: a name, and who they swim for. */
export interface TimerAthlete {
  id: string;
  firstName: string;
  lastName: string;
  team?: string;
}

export interface TimerSnapshot {
  /** The server's clock, so six phones can be compared to one another later. */
  serverTime: number;
  expiresAt: number;
  meet: {
    id: string;
    name: string;
    date: string;
    laneCount: number;
    /** The teams racing, for the "add a swimmer" buttons. */
    teams: TimerTeam[];
  };
  /**
   * What to call athletes with no team of their own at this meet. The host
   * where there is one, so a timer at a home meet sees the home team named
   * rather than the word "Home".
   */
  ownTeam: string;
  /** In running order. */
  events: MeetEvent[];
  heats: Heat[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  athletes: TimerAthlete[];
  /** Only this device's own times. Another timer's is not a hint. */
  mine: Watch[];
}

export async function timerSnapshot(
  db: D1Database,
  grant: Grant,
  timerId: string,
  now = Date.now(),
): Promise<TimerSnapshot | null> {
  const detail = await meetDetail(db, grant.meetId);
  if (!detail) return null;

  // Short labels to group the picker under, from the teams actually racing.
  const label = new Map(detail.teams.map((t) => [t.id, t.code || t.name] as const));
  const teamOf = new Map<string, string>();
  for (const enrolled of detail.enrollments) {
    if (!teamOf.has(enrolled.athleteId)) {
      teamOf.set(enrolled.athleteId, label.get(enrolled.teamId) ?? "");
    }
  }

  const host = detail.meet.hostTeamId
    ? label.get(detail.meet.hostTeamId)
    : undefined;

  return {
    serverTime: now,
    expiresAt: grant.expiresAt,
    meet: {
      id: detail.meet.id,
      name: detail.meet.name,
      date: detail.meet.date,
      laneCount: detail.meet.laneCount,
      teams: detail.teams.map((t) => ({ id: t.id, name: t.name })),
    },
    ownTeam: host || label.get(detail.meet.teamIds[0] ?? "") || "Home",
    events: detail.events,
    heats: detail.heats,
    entries: detail.entries,
    // Selected fields only — a timer never receives a birth date, which is the
    // one thing on an athlete record worth guarding.
    athletes: detail.athletes.map((a) => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      team: teamOf.get(a.id) || undefined,
    })),
    mine: detail.watches.filter((w) => w.timerId === timerId),
  };
}

/**
 * A stopwatch being armed, and later stopped.
 *
 * Folded onto whatever is already there rather than replacing it, because the
 * two halves arrive as separate messages and a stop must not erase the start
 * it belongs to. Keyed like a watch — heat, lane, timer — so the same phone
 * pressing start twice is one row.
 */
export async function markActivity(
  db: D1Database,
  meetId: string,
  row: {
    heatId: string;
    lane: number;
    timerId: string;
    startedAt?: number;
    stoppedAt?: number;
  },
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO timer_activity
         (meet_id, heat_id, lane, timer_id, started_at, stopped_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (heat_id, lane, timer_id) DO UPDATE SET
         started_at = COALESCE(excluded.started_at, timer_activity.started_at),
         stopped_at = COALESCE(excluded.stopped_at, timer_activity.stopped_at),
         updated_at = excluded.updated_at`,
    )
    .bind(
      meetId,
      row.heatId,
      row.lane,
      row.timerId,
      row.startedAt ?? null,
      row.stoppedAt ?? null,
      Date.now(),
    )
    .run();
}

export interface Activity {
  startedAt?: number;
  stoppedAt?: number;
}

/**
 * What this timer's stopwatch did on this lane, as recorded so far.
 *
 * Read rather than inferred from the request, because the four messages a
 * timer sends do not have to arrive together. `start` goes up on its own the
 * moment the thumb lands — that is the whole point of it, so the desk sees an
 * armed lane before the gun — and by the time `submit` follows, the start has
 * long since been accepted and its cookie cleared. Deciding whether the
 * built-in stopwatch was used from whatever happened to be in the last
 * request marked every properly-timed lane as typed in by hand.
 */
export async function readActivity(
  db: D1Database,
  heatId: string,
  lane: number,
  timerId: string,
): Promise<Activity> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      `SELECT started_at, stopped_at FROM timer_activity
       WHERE heat_id = ? AND lane = ? AND timer_id = ?`,
    )
    .bind(heatId, lane, timerId)
    .first<{ started_at: number | null; stopped_at: number | null }>();

  return {
    startedAt: row?.started_at ?? undefined,
    stoppedAt: row?.stopped_at ?? undefined,
  };
}

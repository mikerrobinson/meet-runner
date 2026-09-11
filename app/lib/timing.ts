/**
 * Working an official time out of the watches on a lane.
 *
 * The rules are the ones swimming has always used for hand timing, and the
 * reason they're here rather than in a document is that a derived time can't
 * conflict: three timers each record their own watch, every device computes
 * the same official time from the same three, and nobody overwrites anybody.
 */

import type {
  AcceptedResult,
  Heat,
  MeetDoc,
  Result,
  Ruling,
  WatchTime,
} from "~/types/meet";
import { acceptedResultId, rulingId, watchId } from "~/types/meet";

/**
 * Swim times are truncated to hundredths, never rounded up: two watches
 * averaging 27.145 give 27.14. A time you didn't swim is not a time.
 */
export function truncateToHundredths(ms: number): number {
  return Math.floor(ms / 10) * 10;
}

export interface OfficialTime {
  timeMs: number;
  method: "single" | "average" | "median";
  watchCount: number;
}

/**
 * The official time from a set of watches.
 *
 * One watch stands on its own. Two are averaged. Three or more take the
 * middle one — which is the point of a third watch: it outvotes a slow thumb
 * rather than dragging the average toward it. An even number above two is
 * averaged across the middle pair, for want of a single middle.
 */
export function officialTime(watches: WatchTime[]): OfficialTime | null {
  if (watches.length === 0) return null;

  const times = watches.map((w) => w.timeMs).sort((a, b) => a - b);

  if (times.length === 1) {
    return { timeMs: times[0], method: "single", watchCount: 1 };
  }

  if (times.length === 2) {
    return {
      timeMs: truncateToHundredths((times[0] + times[1]) / 2),
      method: "average",
      watchCount: 2,
    };
  }

  const middle = times.length / 2;
  if (times.length % 2 === 1) {
    return {
      timeMs: times[Math.floor(middle)],
      method: "median",
      watchCount: times.length,
    };
  }

  return {
    timeMs: truncateToHundredths((times[middle - 1] + times[middle]) / 2),
    method: "median",
    watchCount: times.length,
  };
}

export function watchesForLane(
  meet: Pick<MeetDoc, "watches">,
  heatId: string,
  lane: number,
): WatchTime[] {
  return meet.watches
    .filter((w) => w.heatId === heatId && w.lane === lane)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export function rulingForLane(
  meet: Pick<MeetDoc, "rulings">,
  heatId: string,
  lane: number,
): Ruling | undefined {
  return meet.rulings.find((r) => r.id === rulingId(heatId, lane));
}

/**
 * Who the timers say was in a lane, when they say anything at all.
 *
 * Several timers on one lane can name different people, so the most-named
 * wins and an even split is broken by whoever reported first — which makes
 * the answer deterministic rather than dependent on row order.
 */
export function attributedAthlete(watches: WatchTime[]): string | undefined {
  const named = watches.filter((w) => w.athleteId);
  if (named.length === 0) return undefined;

  const votes = new Map<string, { count: number; first: number }>();
  for (const watch of named) {
    const existing = votes.get(watch.athleteId!);
    if (existing) {
      existing.count += 1;
      existing.first = Math.min(existing.first, watch.recordedAt);
    } else {
      votes.set(watch.athleteId!, { count: 1, first: watch.recordedAt });
    }
  }

  return [...votes.entries()].sort(
    ([, a], [, b]) => b.count - a.count || a.first - b.first,
  )[0][0];
}

/**
 * The result for one lane, or null if nothing has been recorded there.
 *
 * A ruling outranks the watches: a DQ stands whatever the stopwatches said,
 * and a coach who types a time over them has decided the watches were wrong.
 *
 * Who the swim belongs to is the coach's lineup wherever the lineup has an
 * opinion — a timer saying they saw somebody else must never rewrite the
 * running order. But an *empty* lane is the lineup having no opinion at all,
 * and there the timers are the only witnesses: an exhibition swim, a late
 * entry, a visiting swimmer nobody seeded. Dropping those times silently was
 * worse than crediting them, because the swim genuinely happened and the
 * stopwatch genuinely recorded it.
 */
export function acceptedForLane(
  meet: Pick<MeetDoc, "results">,
  heatId: string,
  lane: number,
): AcceptedResult | undefined {
  return meet.results?.find((r) => r.id === acceptedResultId(heatId, lane));
}

export function resultForLane(
  meet: Pick<MeetDoc, "watches" | "rulings" | "results">,
  heat: Heat,
  lane: number,
): Result | null {
  const watches = watchesForLane(meet, heat.id, lane);

  // An accepted result is the answer, full stop. It's what makes a watch that
  // turns up afterwards harmless rather than something to guard against.
  const accepted = acceptedForLane(meet, heat.id, lane);
  if (accepted) {
    return {
      eventId: accepted.eventId,
      heatId: accepted.heatId,
      athleteId: accepted.athleteId,
      lane: accepted.lane,
      timeMs: accepted.timeMs,
      status: accepted.status,
      recordedAt: accepted.acceptedAt,
      method: accepted.fromWatches?.method ?? "official",
      watchCount: accepted.fromWatches?.watchCount ?? watches.length,
      manual: accepted.fromWatches === undefined,
      accepted: true,
      acceptedAt: accepted.acceptedAt,
      ...(heat.lanes[lane - 1] ? {} : { attributed: true }),
    };
  }

  const seated = heat.lanes[lane - 1];
  const athleteId = seated ?? attributedAthlete(watches);
  if (!athleteId) return null;
  const ruling = rulingForLane(meet, heat.id, lane);
  const derived = officialTime(watches);

  if (!ruling && !derived) return null;

  const base = {
    eventId: heat.eventId,
    heatId: heat.id,
    athleteId,
    lane,
    ...(seated ? {} : { attributed: true }),
  };

  // A coach's own time replaces whatever the watches said.
  if (ruling?.timeMs !== undefined) {
    return {
      ...base,
      timeMs: ruling.timeMs,
      status: ruling.status,
      recordedAt: ruling.decidedAt,
      method: "official",
      watchCount: watches.length,
      manual: true,
    };
  }

  if (!derived) {
    // A DQ or no-show with nothing on the clock.
    return {
      ...base,
      timeMs: 0,
      status: ruling!.status,
      recordedAt: ruling!.decidedAt,
      method: "official",
      watchCount: 0,
      manual: true,
    };
  }

  return {
    ...base,
    timeMs: derived.timeMs,
    status: ruling?.status ?? "OK",
    recordedAt: Math.max(...watches.map((w) => w.recordedAt)),
    method: derived.method,
    watchCount: derived.watchCount,
    manual: watches.every((w) => w.source === "typed"),
  };
}

/** Every result in a heat, in lane order. */
export function resultsForHeat(
  meet: Pick<MeetDoc, "watches" | "rulings" | "results">,
  heat: Heat,
): Result[] {
  return heat.lanes
    .map((_, index) => resultForLane(meet, heat, index + 1))
    .filter((r): r is Result => r !== null);
}

/**
 * How many lanes have something recorded — the meet's "times" count.
 * Cheaper than deriving every result just to count them.
 */
export function recordedCount(
  meet: Pick<MeetDoc, "watches" | "rulings">,
): number {
  const lanes = new Set<string>();
  for (const w of meet.watches) lanes.add(`${w.heatId}:${w.lane}`);
  for (const r of meet.rulings) lanes.add(`${r.heatId}:${r.lane}`);
  return lanes.size;
}

/** Every result in the meet, for the results screen and exports. */
export function allResults(
  meet: Pick<MeetDoc, "watches" | "rulings" | "results" | "heats">,
): Result[] {
  return meet.heats.flatMap((heat) => resultsForHeat(meet, heat));
}

export function makeWatch(
  heat: Heat,
  lane: number,
  timerId: string,
  timeMs: number,
  source: WatchTime["source"],
): WatchTime {
  return {
    id: watchId(heat.id, lane, timerId),
    eventId: heat.eventId,
    heatId: heat.id,
    lane,
    timerId,
    timeMs,
    recordedAt: Date.now(),
    source,
  };
}

export function makeRuling(
  heat: Heat,
  lane: number,
  status: Ruling["status"],
  timeMs?: number,
  by?: string,
): Ruling {
  return {
    id: rulingId(heat.id, lane),
    eventId: heat.eventId,
    heatId: heat.id,
    lane,
    status,
    timeMs,
    decidedAt: Date.now(),
    decidedBy: by,
  };
}

/* ----------------------------------------------------------------- closing */

/**
 * Lanes in a heat that somebody actually swam.
 *
 * Seeded lanes, plus any empty lane a timer put a name to. An empty lane
 * nobody claimed isn't waiting on anything, so it can't hold a heat open.
 */
export function activeLanes(
  meet: Pick<MeetDoc, "watches">,
  heat: Heat,
): number[] {
  const lanes: number[] = [];
  for (let lane = 1; lane <= heat.lanes.length; lane++) {
    if (heat.lanes[lane - 1]) {
      lanes.push(lane);
      continue;
    }
    if (attributedAthlete(watchesForLane(meet, heat.id, lane))) lanes.push(lane);
  }
  return lanes;
}

/**
 * A heat is closed once every lane that swam has been accepted.
 *
 * Derived rather than stored, for the same reason official times are: there is
 * no second fact to keep in step, so "closed" can never disagree with the
 * results underneath it. A heat nobody swam is not closed — it hasn't started.
 */
export function heatClosed(
  meet: Pick<MeetDoc, "watches" | "results">,
  heat: Heat,
): boolean {
  const lanes = activeLanes(meet, heat);
  if (lanes.length === 0) return false;
  return lanes.every((lane) => acceptedForLane(meet, heat.id, lane) !== undefined);
}

/** An event is closed once all of its heats are. Its results are then official. */
export function eventClosed(
  meet: Pick<MeetDoc, "watches" | "results" | "heats">,
  eventId: string,
): boolean {
  const heats = meet.heats.filter((heat) => heat.eventId === eventId);
  if (heats.length === 0) return false;
  return heats.every((heat) => heatClosed(meet, heat));
}

/** How far along a heat is, for a screen that has to show progress. */
export function heatProgress(
  meet: Pick<MeetDoc, "watches" | "results">,
  heat: Heat,
): { accepted: number; active: number } {
  const lanes = activeLanes(meet, heat);
  return {
    accepted: lanes.filter(
      (lane) => acceptedForLane(meet, heat.id, lane) !== undefined,
    ).length,
    active: lanes.length,
  };
}

/**
 * Accept what the watches worked out for a lane, or a correction of it.
 *
 * `override` is how an administrator disagrees: a different time, a different
 * status, or a different swimmer. What the watches said is kept alongside, so
 * the record still shows what was on screen when the call was made.
 */
export function acceptResult(
  meet: Pick<MeetDoc, "watches" | "rulings" | "results">,
  heat: Heat,
  lane: number,
  by: string | undefined,
  override: Partial<Pick<AcceptedResult, "timeMs" | "status" | "athleteId">> = {},
  now = Date.now(),
): AcceptedResult | null {
  const proposed = resultForLane(meet, heat, lane);
  const athleteId = override.athleteId ?? proposed?.athleteId;
  if (!athleteId) return null;

  const watches = watchesForLane(meet, heat.id, lane);
  const derived = officialTime(watches);

  return {
    id: acceptedResultId(heat.id, lane),
    eventId: heat.eventId,
    heatId: heat.id,
    lane,
    athleteId,
    timeMs: override.timeMs ?? proposed?.timeMs ?? 0,
    status: override.status ?? proposed?.status ?? "OK",
    acceptedAt: now,
    acceptedBy: by,
    ...(derived
      ? {
          fromWatches: {
            timeMs: derived.timeMs,
            watchCount: derived.watchCount,
            method: derived.method,
          },
        }
      : {}),
  };
}

/**
 * Working an official time out of the watches on a lane.
 *
 * The rules are the ones swimming has always used for hand timing, and the
 * reason they're here rather than in a document is that a derived time can't
 * conflict: three timers each record their own watch, every device computes
 * the same official time from the same three, and nobody overwrites anybody.
 */

import type { Heat, MeetDoc, Result, Ruling, WatchTime } from "~/types/meet";
import { rulingId, watchId } from "~/types/meet";

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
 * The result for one lane, or null if nothing has been recorded there.
 *
 * A ruling outranks the watches: a DQ stands whatever the stopwatches said,
 * and a coach who types a time over them has decided the watches were wrong.
 */
export function resultForLane(
  meet: Pick<MeetDoc, "watches" | "rulings">,
  heat: Heat,
  lane: number,
): Result | null {
  const athleteId = heat.lanes[lane - 1];
  if (!athleteId) return null;

  const watches = watchesForLane(meet, heat.id, lane);
  const ruling = rulingForLane(meet, heat.id, lane);
  const derived = officialTime(watches);

  if (!ruling && !derived) return null;

  const base = {
    eventId: heat.eventId,
    heatId: heat.id,
    athleteId,
    lane,
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
  meet: Pick<MeetDoc, "watches" | "rulings">,
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
  meet: Pick<MeetDoc, "watches" | "rulings" | "heats">,
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
): Ruling {
  return {
    id: rulingId(heat.id, lane),
    eventId: heat.eventId,
    heatId: heat.id,
    lane,
    status,
    timeMs,
    decidedAt: Date.now(),
  };
}

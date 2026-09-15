/**
 * Working an official time out of the watches on a lane, and recording what
 * an administrator decided about it.
 *
 * Two concepts, not three. **Watches** are evidence: several per lane, one per
 * timer, nobody overwriting anybody. A **call** is the decision: one per lane,
 * carrying the status, optionally the official's own reading of the clock, and
 * whether it has been signed off. Everything else — the proposed time, which
 * lanes swam, whether a heat or an event is closed — is derived, so it can
 * never disagree with the rows underneath it.
 *
 * Everything here is pure and takes plain arrays. No document, no store.
 */

import type {
  Heat,
  LaneCall,
  MeetEvent,
  Result,
  ResultStatus,
  TimeMethod,
  TimerActivity,
  Watch,
  WatchRole,
} from "~/types/meet";

/** The rows these functions read. Anything holding both will do. */
export interface TimingRows {
  watches: Watch[];
  calls: LaneCall[];
}

/**
 * Swim times are truncated to hundredths, never rounded up: two watches
 * averaging 27.145 give 27.14. A time you didn't swim is not a time.
 */
export function truncateToHundredths(ms: number): number {
  return Math.floor(ms / 10) * 10;
}

export interface ProposedTime {
  timeMs: number;
  method: "single" | "average" | "median";
  watchCount: number;
}

/**
 * What the watches work out to.
 *
 * One watch stands on its own. Two are averaged. Three or more take the middle
 * one — which is the point of a third watch: it outvotes a slow thumb rather
 * than dragging the average toward it. An even number above two is averaged
 * across the middle pair, for want of a single middle.
 */
export function proposedTime(watches: Watch[]): ProposedTime | null {
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

/**
 * The mean of some times, truncated to hundredths.
 *
 * Truncated, not rounded, for the same reason every other time in this app is:
 * a time you didn't swim is not a time.
 */
function meanOf(times: number[]): number {
  return truncateToHundredths(
    times.reduce((sum, ms) => sum + ms, 0) / times.length,
  );
}

export interface LaneTime {
  timeMs: number;
  method: TimeMethod;
  /** How many watches the number was worked out from. */
  watchCount: number;
  /** Which tier answered, so a screen can say why. */
  from: WatchRole;
}

/**
 * The time for a lane, and the single place that decides which one it is.
 *
 * Three tiers, asked in order, because the watches on a lane are not all the
 * same kind of evidence:
 *
 * 1. **The administrator's own reading.** Whoever runs the meet has looked at
 *    the lane, the watches and whatever the timers are telling them, and said
 *    what it was. That is a ruling and it stands — it is the paper system's
 *    "the referee decides", and the reason it is stored as a watch rather than
 *    a separate field is that it is still a reading of a clock by a person,
 *    and still worth keeping when somebody wants to know what it overrode.
 *
 * 2. **The timers, by the hand-timing rules.** Three watches take the middle
 *    one, two are averaged, one stands alone. This is the official procedure
 *    and it is what the third timer is *for*: the median outvotes a slow thumb
 *    rather than letting it drag an average.
 *
 * 3. **The coaches, averaged.** A fallback for a lane the timing table missed
 *    — a volunteer who didn't turn up, a phone that died. Coaches are timing
 *    their own swimmers from the side, which is a worse position and an
 *    interested one, so their times answer only when nothing better did. An
 *    average rather than a median because there is no reason to expect three
 *    of them, and the middle of two is the average anyway.
 *
 * Tiers are never mixed. Averaging a coach's watch in with the timers' would
 * let the side of the pool quietly move an official time, and taking the
 * median across all of them would do the same thing less visibly.
 */
export function laneTime(watches: Watch[]): LaneTime | null {
  const byRole = (role: WatchRole) => watches.filter((w) => w.role === role);

  // The most recent, if an administrator has somehow left two — a later
  // reading replaces an earlier one rather than being averaged with it.
  const official = byRole("admin").sort(
    (a, b) => b.recordedAt - a.recordedAt,
  )[0];
  if (official) {
    return {
      timeMs: official.timeMs,
      method: "official",
      watchCount: 1,
      from: "admin",
    };
  }

  const timers = proposedTime(byRole("timer"));
  if (timers) {
    return { ...timers, from: "timer" };
  }

  const coaches = byRole("coach");
  if (coaches.length > 0) {
    return {
      timeMs: meanOf(coaches.map((w) => w.timeMs)),
      method: coaches.length === 1 ? "single" : "average",
      watchCount: coaches.length,
      from: "coach",
    };
  }

  return null;
}

export type LaneProgress = "none" | "waiting" | "complete";

/**
 * How far along a lane's timing is, for a desk watching a heat go off.
 *
 * Three answers, and the middle one is the reason this exists. A lane with
 * nothing on it looks identical to a lane whose timers are all still holding
 * their clocks — and those need opposite responses: one wants somebody sent to
 * cover it, the other wants leaving alone. `start` is sent on its own the
 * instant a thumb lands precisely so this can tell them apart.
 *
 * "Complete" means every stopwatch known to be running on this lane has since
 * been submitted. Known from two places: who armed (`activity`) and who has
 * sent a time. A timer who typed a time without ever starting a watch counts
 * as in; a timer who armed and hasn't submitted is what holds the lane open.
 *
 * Only timers count. A coach's watch and the desk's own reading are not what
 * the lane is waiting for — the timing table is.
 */
export function laneProgress(
  rows: { watches: Watch[]; activity: TimerActivity[] },
  heatId: string,
  lane: number,
): LaneProgress {
  const armed = new Set(
    rows.activity
      .filter(
        (a) =>
          a.heatId === heatId && a.lane === lane && a.startedAt !== undefined,
      )
      .map((a) => a.timerId),
  );
  const submitted = new Set(
    rows.watches
      .filter(
        (w) => w.heatId === heatId && w.lane === lane && w.role === "timer",
      )
      .map((w) => w.timerId),
  );

  if (armed.size === 0 && submitted.size === 0) return "none";
  if (submitted.size === 0) return "waiting";
  for (const timerId of armed) {
    if (!submitted.has(timerId)) return "waiting";
  }
  return "complete";
}

/**
 * Whether a stopwatch in this app timed the race, rather than somebody typing
 * a number in afterwards.
 */
export function fromStopwatch(watch: Watch): boolean {
  return watch.startedAt !== undefined && watch.stoppedAt !== undefined;
}

export function watchesForLane(
  rows: Pick<TimingRows, "watches">,
  heatId: string,
  lane: number,
): Watch[] {
  return rows.watches
    .filter((w) => w.heatId === heatId && w.lane === lane)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export function callForLane(
  rows: Pick<TimingRows, "calls">,
  heatId: string,
  lane: number,
): LaneCall | undefined {
  return rows.calls.find((c) => c.heatId === heatId && c.lane === lane);
}

/**
 * Who swam in a lane.
 *
 * The seat, unless a call corrects it. There is no third answer: a timer who
 * names somebody writes the seat, so by the time anything reads this the
 * disagreement has already been settled by whoever wrote last.
 */
export function athleteInLane(
  rows: Pick<TimingRows, "calls">,
  heat: Heat,
  lane: number,
): string | null {
  return (
    callForLane(rows, heat.id, lane)?.athleteId ?? heat.lanes[lane - 1] ?? null
  );
}

/**
 * The result for one lane, or null if there is nothing to say.
 *
 * A call's own `timeMs` outranks the watches — an official who types a time
 * has decided the watches were wrong. A call with no time falls through to
 * them, which is what makes taking back a sign-off land on the official's
 * reading rather than on the raw watches.
 *
 * Returns null when nobody is in the lane, even if there are watches on it.
 * That combination is a time with no swimmer, which is a hole for a human to
 * fill rather than a result to publish — the control desk surfaces it from
 * `activeLanes` and `watchesForLane`.
 */
export function resultForLane(
  rows: TimingRows,
  heat: Heat,
  lane: number,
): Result | null {
  const athleteId = athleteInLane(rows, heat, lane);
  if (!athleteId) return null;

  const watches = watchesForLane(rows, heat.id, lane);
  const call = callForLane(rows, heat.id, lane);
  const derived = laneTime(watches);
  if (!call && !derived) return null;

  const base = {
    meetId: heat.meetId,
    eventId: heat.eventId,
    heatId: heat.id,
    athleteId,
    lane,
    status: call?.status ?? "OK",
    ...(call?.final ? { final: true } : {}),
  };

  // The official's own reading, whether or not it has been signed off. It
  // outranks everything: typing a time is deciding the watches were wrong.
  if (call?.timeMs !== undefined) {
    return {
      ...base,
      timeMs: call.timeMs,
      recordedAt: call.decidedAt,
      method: "official",
      watchCount: watches.length,
      manual: true,
    };
  }

  /**
   * A signed-off lane reads what the watches said *at the moment it was signed
   * off*, not what they say now.
   *
   * This is what makes a late watch harmless. A timer's phone that was offline
   * all afternoon can push whenever it reconnects; the lane doesn't move,
   * because the number was fixed when somebody accepted it. The watch is still
   * recorded and still timestamped, so the call can be reopened deliberately —
   * and taking the sign-off back drops straight through to the live watches,
   * which is exactly when you'd want the late one to count.
   *
   * The old model got this by storing the accepted time on a separate row.
   * Folding that row into the call nearly lost the property: with no stored
   * number, a signed-off lane fell through to the watches and a time arriving
   * afterwards silently changed an official result.
   */
  if (call?.final && call.fromWatches) {
    return {
      ...base,
      timeMs: call.fromWatches.timeMs,
      recordedAt: call.decidedAt,
      method: call.fromWatches.method,
      watchCount: call.fromWatches.watchCount,
    };
  }

  if (!derived) {
    // A DQ or a no-show with nothing on the clock.
    return {
      ...base,
      timeMs: 0,
      recordedAt: call!.decidedAt,
      method: "official",
      watchCount: 0,
      manual: true,
    };
  }

  return {
    ...base,
    timeMs: derived.timeMs,
    recordedAt: Math.max(...watches.map((w) => w.recordedAt)),
    method: derived.method,
    watchCount: derived.watchCount,
    manual: watches.every((w) => !fromStopwatch(w)),
  };
}

/** Every result in a heat, in lane order. */
export function resultsForHeat(rows: TimingRows, heat: Heat): Result[] {
  return heat.lanes
    .map((_, index) => resultForLane(rows, heat, index + 1))
    .filter((r): r is Result => r !== null);
}

/** Every result in the meet, for the results screen and exports. */
export function allResults(rows: TimingRows & { heats: Heat[] }): Result[] {
  return rows.heats.flatMap((heat) => resultsForHeat(rows, heat));
}

/**
 * How many lanes have something recorded — the meet's "times" count. Cheaper
 * than deriving every result just to count them.
 */
export function recordedCount(rows: TimingRows): number {
  const lanes = new Set<string>();
  for (const w of rows.watches) lanes.add(`${w.heatId}:${w.lane}`);
  for (const c of rows.calls) lanes.add(`${c.heatId}:${c.lane}`);
  return lanes.size;
}

/* ----------------------------------------------------------------- closing */

/**
 * Lanes in a heat that somebody actually swam.
 *
 * A seated lane, or an empty one that has a watch or a call against it. The
 * second half matters: a time on an unseeded lane is exactly the thing that
 * must hold a heat open until somebody decides whose it was. An untouched
 * empty lane isn't waiting on anything.
 */
export function activeLanes(rows: TimingRows, heat: Heat): number[] {
  const lanes: number[] = [];
  for (let lane = 1; lane <= heat.lanes.length; lane++) {
    if (
      heat.lanes[lane - 1] ||
      rows.watches.some((w) => w.heatId === heat.id && w.lane === lane) ||
      rows.calls.some((c) => c.heatId === heat.id && c.lane === lane)
    ) {
      lanes.push(lane);
    }
  }
  return lanes;
}

/**
 * Whether anything has been recorded against a heat.
 *
 * The test for "this heat is history now". Reseeding lanes, or changing the
 * pool's width, may rearrange a heat nobody has swum; once there is a watch or
 * a call pointing at it, rearranging it would leave those pointing at lanes
 * that no longer mean what they meant.
 */
export function heatTouched(rows: TimingRows, heat: Pick<Heat, "id">): boolean {
  return (
    rows.watches.some((w) => w.heatId === heat.id) ||
    rows.calls.some((c) => c.heatId === heat.id)
  );
}

/**
 * A heat is closed once every lane that swam has been signed off.
 *
 * Derived rather than stored, for the same reason official times are: there is
 * no second fact to keep in step, so "closed" can never disagree with the
 * calls underneath it. A heat nobody swam is not closed — it hasn't started.
 */
export function heatClosed(rows: TimingRows, heat: Heat): boolean {
  const lanes = activeLanes(rows, heat);
  if (lanes.length === 0) return false;
  return lanes.every(
    (lane) => callForLane(rows, heat.id, lane)?.final === true,
  );
}

/** An event is closed once all of its heats are. Its results are then official. */
export function eventClosed(
  rows: TimingRows & { heats: Heat[] },
  eventId: string,
): boolean {
  const heats = rows.heats.filter((heat) => heat.eventId === eventId);
  if (heats.length === 0) return false;
  return heats.every((heat) => heatClosed(rows, heat));
}

/** How far along a heat is, for a screen that has to show progress. */
export function heatProgress(
  rows: TimingRows,
  heat: Heat,
): { signedOff: number; active: number } {
  const lanes = activeLanes(rows, heat);
  return {
    signedOff: lanes.filter(
      (lane) => callForLane(rows, heat.id, lane)?.final === true,
    ).length,
    active: lanes.length,
  };
}

/* ----------------------------------------------------------------- writing */

/**
 * The call to write for a lane, given what's there and what changed.
 *
 * Built by folding a patch onto whatever call already exists, so marking a DQ
 * keeps a time that was typed and typing a time keeps a DQ — the two are
 * separate fields of one decision and neither erases the other.
 *
 * Signing off copies the lane's time — whatever `laneTime` says it is, by
 * whichever tier answered — onto the call, so the record can still answer
 * "what was accepted?" after a late watch arrives or a watch is discarded.
 */
export function makeCall(
  rows: TimingRows,
  heat: Heat,
  lane: number,
  patch: {
    status?: ResultStatus;
    timeMs?: number | null;
    athleteId?: string | null;
    final?: boolean;
  },
  by: string | undefined,
  now = Date.now(),
): LaneCall {
  const existing = callForLane(rows, heat.id, lane);
  const derived = laneTime(watchesForLane(rows, heat.id, lane));

  const timeMs =
    patch.timeMs === null ? undefined : (patch.timeMs ?? existing?.timeMs);
  const athleteId =
    patch.athleteId === null
      ? undefined
      : (patch.athleteId ?? existing?.athleteId);
  const final = patch.final ?? existing?.final ?? false;

  return {
    heatId: heat.id,
    lane,
    athleteId,
    status: patch.status ?? existing?.status ?? "OK",
    timeMs,
    final,
    decidedBy: by,
    decidedAt: now,
    ...(final && derived
      ? {
          fromWatches: {
            timeMs: derived.timeMs,
            watchCount: derived.watchCount,
            method: derived.method as TimeMethod,
          },
        }
      : existing?.fromWatches
        ? { fromWatches: existing.fromWatches }
        : {}),
  };
}

/** Events in the order they're swum. */
export function orderedEvents(events: MeetEvent[]): MeetEvent[] {
  return [...events].sort((a, b) => a.position - b.position);
}

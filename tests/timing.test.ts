import { done, eq } from "./harness.ts";
import {
  fromStopwatch,
  laneProgress,
  laneTime,
  activeLanes,
  athleteInLane,
  callForLane,
  eventClosed,
  heatClosed,
  heatProgress,
  heatTouched,
  makeCall,
  proposedTime,
  recordedCount,
  resultForLane,
  truncateToHundredths,
  watchesForLane,
} from "../app/lib/timing.ts";
import type { Heat, LaneCall, Watch } from "../app/types/meet.ts";

const MEET = "m1";
const EVENT = "e1";

function heat(id: string, lanes: (string | null)[]): Heat {
  return { id, meetId: MEET, eventId: EVENT, index: 0, lanes };
}

function watch(
  heatId: string,
  lane: number,
  timerId: string,
  timeMs: number,
  extra: Partial<Watch> = {},
): Watch {
  return {
    heatId,
    lane,
    timerId,
    role: "timer",
    timeMs,
    recordedAt: 1_000,
    ...extra,
  };
}

/* ---------------------------------------------------- the hand-timing rules */

eq(truncateToHundredths(27_145), 27_140, "times truncate, never round up");
eq(proposedTime([]), null, "no watches, no time");

eq(
  proposedTime([watch("h", 1, "a", 27_140)]),
  { timeMs: 27_140, method: "single", watchCount: 1 },
  "one watch stands on its own",
);

eq(
  proposedTime([watch("h", 1, "a", 27_140), watch("h", 1, "b", 27_150)]),
  { timeMs: 27_140, method: "average", watchCount: 2 },
  "two are averaged, and the average truncates",
);

// The point of a third watch: it outvotes a slow thumb rather than dragging
// the average toward it.
eq(
  proposedTime([
    watch("h", 1, "a", 27_140),
    watch("h", 1, "b", 27_150),
    watch("h", 1, "c", 31_000),
  ]),
  { timeMs: 27_150, method: "median", watchCount: 3 },
  "three take the middle one, so a slow thumb can't drag it",
);

eq(
  proposedTime([
    watch("h", 1, "a", 27_100),
    watch("h", 1, "b", 27_200),
    watch("h", 1, "c", 27_300),
    watch("h", 1, "d", 27_400),
  ])?.timeMs,
  27_250,
  "an even number above two averages the middle pair",
);

/* ------------------------------------------------- the seat is the answer */

{
  const h = heat("h1", ["a1", null, null]);
  const rows = { watches: [watch("h1", 2, "t1", 30_000)], calls: [] as LaneCall[] };

  eq(athleteInLane(rows, h, 1), "a1", "a seated lane is whoever is seated");
  eq(
    athleteInLane(rows, h, 2),
    null,
    "a watch on an empty lane names nobody — a timer who knows writes the seat",
  );
  eq(
    resultForLane(rows, h, 2),
    null,
    "so a time with no swimmer is not a result",
  );
  eq(
    activeLanes(rows, h),
    [1, 2],
    "but it still holds the heat open until somebody decides whose it was",
  );

  // A call may correct who swam — that is one of the things a call is for.
  const corrected = {
    ...rows,
    calls: [
      { heatId: "h1", lane: 2, athleteId: "a9", status: "OK", final: false, decidedAt: 2 },
    ] as LaneCall[],
  };
  eq(athleteInLane(corrected, h, 2), "a9", "a call outranks the seat");
  eq(resultForLane(corrected, h, 2)?.timeMs, 30_000, "and the watch then counts");
}

/* ----------------------------------------------- evidence, then a decision */

{
  const h = heat("h2", ["a1", "a2", null]);
  const watches = [
    watch("h2", 1, "t1", 27_140),
    watch("h2", 1, "t2", 27_160),
    watch("h2", 2, "t1", 31_000),
  ];
  const rows = { watches, calls: [] as LaneCall[] };

  const proposed = resultForLane(rows, h, 1)!;
  eq(proposed.timeMs, 27_150, "a lane with watches proposes their average");
  eq(proposed.method, "average", "and says how it got there");
  eq(proposed.final, undefined, "a proposal is not a decision");
  eq(heatClosed(rows, h), false, "so the heat is open");
  eq(eventClosed({ ...rows, heats: [h] }, EVENT), false, "and so is the event");
  eq(heatProgress(rows, h), { signedOff: 0, active: 2 }, "two lanes swam, none signed off");
  eq(recordedCount(rows), 2, "two lanes have something recorded");
  eq(heatTouched(rows, h), true, "and the heat is history now");

  /* ---- signing a lane off ---- */

  const call = makeCall(rows, h, 1, { final: true }, "u1", 5_000);
  eq(call.final, true, "signing off sets final");
  eq(call.timeMs, undefined, "and does not copy the watches into the call");
  eq(
    call.fromWatches,
    { timeMs: 27_150, watchCount: 2, method: "average" },
    "but records what they said at the time",
  );
  eq(call.decidedBy, "u1", "and who made the call");

  const signed = { ...rows, calls: [call] };
  eq(resultForLane(signed, h, 1)?.final, true, "the lane now reads as official");
  eq(resultForLane(signed, h, 1)?.timeMs, 27_150, "at what the watches worked out");
  eq(heatClosed(signed, h), false, "lane 2 is still outstanding");

  /* ---- a late watch is harmless ---- */

  const late = {
    ...signed,
    watches: [...watches, watch("h2", 1, "t9", 9_999, { recordedAt: 99_000 })],
  };
  eq(
    resultForLane(late, h, 1)?.timeMs,
    27_150,
    "a watch arriving after the sign-off doesn't move the result",
  );
  eq(
    watchesForLane(late, "h2", 1).length,
    3,
    "though it is still on file for anyone who wants to reopen it",
  );

  // And reopening is what makes it count. Taking the sign-off back drops
  // through to the live watches, which now include the late one.
  const reopened = {
    ...late,
    calls: [makeCall(late, h, 1, { final: false }, "u1", 100_000)],
  };
  // Three watches now — 9.999, 27.140, 27.160 — so the median is 27.140
  // rather than the two-watch average of 27.150. The garbage watch moves the
  // answer, which is precisely why reopening a signed-off lane is deliberate.
  eq(
    resultForLane(reopened, h, 1)?.timeMs,
    27_140,
    "undoing a sign-off returns to the watches, late one included",
  );
  eq(
    resultForLane(reopened, h, 1)?.method,
    "median",
    "and says it read three of them",
  );

  /* ---- closing ---- */

  const both = {
    ...rows,
    calls: [call, makeCall(rows, h, 2, { final: true }, "u1", 5_000)],
  };
  eq(heatClosed(both, h), true, "every lane that swam is signed off, so the heat is closed");
  eq(eventClosed({ ...both, heats: [h] }, EVENT), true, "and the event is official");
}

/* ------------------------------------------- one call, three separate fields */

{
  const h = heat("h3", ["a1", null, null]);
  const rows = { watches: [watch("h3", 1, "t1", 30_000)], calls: [] as LaneCall[] };

  // An official typing a time is not the same act as signing the lane off.
  const typed = makeCall(rows, h, 1, { timeMs: 29_990 }, "u1", 100);
  eq(typed.timeMs, 29_990, "a typed time is recorded");
  eq(typed.final, false, "but entering one is not signing the lane off");
  eq(
    resultForLane({ ...rows, calls: [typed] }, h, 1)?.timeMs,
    29_990,
    "and it outranks the watches",
  );

  // Two fields of one decision, and neither erases the other.
  const withRows = { ...rows, calls: [typed] };
  const dq = makeCall(withRows, h, 1, { status: "DQ" }, "u1", 200);
  eq(dq.status, "DQ", "marking a DQ sets the status");
  eq(dq.timeMs, 29_990, "and keeps the time that was typed");

  const retimed = makeCall({ ...rows, calls: [dq] }, h, 1, { timeMs: 28_000 }, "u1", 300);
  eq(retimed.status, "DQ", "and typing a time doesn't quietly undo a DQ");
  eq(retimed.timeMs, 28_000, "while taking the new reading");

  // Taking a sign-off back returns to the official's own reading, not to the
  // raw watches. That property is why the two were once separate objects.
  const off = makeCall({ ...rows, calls: [retimed] }, h, 1, { final: true }, "u1", 400);
  eq(off.final, true, "signed off");
  const undone = makeCall({ ...rows, calls: [off] }, h, 1, { final: false }, "u1", 500);
  eq(undone.final, false, "undone");
  eq(
    undone.timeMs,
    28_000,
    "and the official's own reading survives the undo",
  );
  eq(undone.status, "DQ", "as does the status");
}

/* ------------------------------------------------------ nothing to say yet */

{
  const h = heat("h4", ["a1", null, null]);
  const empty = { watches: [] as Watch[], calls: [] as LaneCall[] };
  eq(resultForLane(empty, h, 1), null, "a seated lane with no time is not a result");
  eq(activeLanes(empty, h), [1], "though it is a lane that has to swim");
  eq(heatClosed(empty, h), false, "a heat nobody swam is not closed — it hasn't started");
  eq(heatTouched(empty, h), false, "and nothing has been recorded against it");

  // A no-show: a decision with nothing on the clock.
  const ns = makeCall(empty, h, 1, { status: "NS", final: true }, "u1", 10);
  const rows = { ...empty, calls: [ns] };
  const result = resultForLane(rows, h, 1)!;
  eq(result.status, "NS", "a no-show reads as one");
  eq(result.timeMs, 0, "with nothing on the clock");
  eq(result.manual, true, "and no stopwatch behind it");
  eq(heatClosed(rows, h), true, "which closes the heat");
  eq(callForLane(rows, "h4", 1)?.final, true, "the call is on the lane");
}

/* ------------------------------------ how far along a lane's timing is */

{
  const H = "hp";
  const armed = (timerId: string, lane = 1) => ({
    heatId: H,
    lane,
    timerId,
    startedAt: 1_000,
    updatedAt: 1_000,
  });

  eq(
    laneProgress({ watches: [], activity: [] }, H, 1),
    "none",
    "a lane nobody has touched is waiting for somebody to cover it",
  );

  // The distinction the colour exists for: this looks identical to the line
  // above if you only read the number, and wants the opposite response.
  eq(
    laneProgress({ watches: [], activity: [armed("d-1")] }, H, 1),
    "waiting",
    "a watch running on it is not nothing — it is in hand",
  );

  eq(
    laneProgress(
      { watches: [watch(H, 1, "d-1", 27_140)], activity: [armed("d-1"), armed("d-2")] },
      H,
      1,
    ),
    "waiting",
    "two armed and one in is still waiting on the second",
  );

  eq(
    laneProgress(
      {
        watches: [watch(H, 1, "d-1", 27_140), watch(H, 1, "d-2", 27_160)],
        activity: [armed("d-1"), armed("d-2")],
      },
      H,
      1,
    ),
    "complete",
    "every watch that started has been sent",
  );

  // A timer who typed a time without ever starting a watch still counts as in.
  eq(
    laneProgress({ watches: [watch(H, 1, "d-9", 27_140)], activity: [] }, H, 1),
    "complete",
    "a time with no watch behind it is still a time that arrived",
  );

  // The timing table is what the lane waits for. A coach timing from the side
  // is not, and neither is the desk's own reading.
  eq(
    laneProgress(
      {
        watches: [watch(H, 1, "u-c", 27_500, { role: "coach" })],
        activity: [armed("d-1")],
      },
      H,
      1,
    ),
    "waiting",
    "a coach's watch doesn't complete a lane the timers haven't",
  );

  eq(
    laneProgress({ watches: [watch(H, 2, "d-1", 27_140)], activity: [] }, H, 1),
    "none",
    "and another lane's watches are no business of this one",
  );
}

/* ------------------------------------------------ which time is the time */

{
  const h = heat("hp", [null, null, null, "swimmer"]);
  const lane = 4;
  const timers = [
    watch("hp", lane, "d-1", 27_140),
    watch("hp", lane, "d-2", 27_160),
    watch("hp", lane, "d-3", 31_000),
  ];
  const coaches = [
    watch("hp", lane, "u-a", 27_500, { role: "coach", userId: "u-a" }),
    watch("hp", lane, "u-b", 27_700, { role: "coach", userId: "u-b" }),
  ];
  const official = watch("hp", lane, "u-ref", 26_990, {
    role: "admin",
    userId: "u-ref",
  });

  eq(laneTime([]), null, "a lane nobody timed has no time");

  /* --- the timers, by the hand-timing rules --- */
  eq(
    laneTime(timers),
    { timeMs: 27_160, method: "median", watchCount: 3, from: "timer" },
    "three timers take the middle one — the slow thumb is outvoted, not averaged",
  );
  eq(
    laneTime(timers.slice(0, 2)),
    { timeMs: 27_150, method: "average", watchCount: 2, from: "timer" },
    "two are averaged",
  );
  eq(
    laneTime([watch("hp", lane, "d-1", 27_145)]),
    { timeMs: 27_145, method: "single", watchCount: 1, from: "timer" },
    "one stands alone",
  );

  /* --- coaches only answer when the timing table didn't --- */
  eq(
    laneTime(coaches),
    { timeMs: 27_600, method: "average", watchCount: 2, from: "coach" },
    "coaches are averaged when there are no timers",
  );
  eq(
    laneTime([...timers, ...coaches])?.timeMs,
    27_160,
    "and are ignored entirely when there are — the side of the pool cannot move an official time",
  );
  eq(
    laneTime([...timers, ...coaches])?.watchCount,
    3,
    "so the count is the timers', not everybody's",
  );

  /* --- the administrator rules --- */
  eq(
    laneTime([...timers, ...coaches, official]),
    { timeMs: 26_990, method: "official", watchCount: 1, from: "admin" },
    "whoever runs the meet decides, whatever the rest say",
  );

  // Truncated, never rounded, wherever an average is taken.
  eq(
    laneTime([
      watch("hp", lane, "u-a", 27_140, { role: "coach" }),
      watch("hp", lane, "u-b", 27_150, { role: "coach" }),
    ])?.timeMs,
    27_140,
    "a coaches' average truncates like every other time",
  );
}

/* ------------------------------------- a time is a time, whoever read it */

{
  // A coach on the multi-lane stopwatch, a volunteer's phone, and an
  // administrator typing at the desk. Three readings of one race, stored the
  // same way and weighed the same way — the desk's number is evidence now,
  // not a ruling that silently outranked the other two.
  const lane = 4;
  const rows = {
    watches: [
      // A volunteer's phone: a stopwatch ran, so it left both timestamps.
      watch("h1", lane, "d-phone", 27_160, {
        startedAt: 1_000,
        stoppedAt: 28_160,
      }),
      // A coach on the multi-lane stopwatch — same thing, with an account.
      watch("h1", lane, "u-coach", 27_140, {
        userId: "u-coach",
        startedAt: 1_000,
        stoppedAt: 28_140,
      }),
      // The desk, typing a number in off a handheld. No clock ran here.
      watch("h1", lane, "u-admin", 31_000, { userId: "u-admin" }),
    ],
    calls: [] as LaneCall[],
  };
  const h = heat("h1", [null, null, null, "swimmer"]);

  eq(
    resultForLane(rows, h, lane)?.timeMs,
    27_160,
    "three readings take the middle one, whoever held the clock",
  );
  eq(
    resultForLane(rows, h, lane)?.method,
    "median",
    "and it is a median like any other",
  );
  eq(
    resultForLane(rows, h, lane)?.watchCount,
    3,
    "all three are counted as evidence",
  );

  // The desk's power over a time is dropping the reading it doesn't believe,
  // which leaves what it did believe on the record.
  const dropped = {
    watches: rows.watches.filter((w) => w.timerId !== "u-admin"),
    calls: rows.calls,
  };
  eq(
    resultForLane(dropped, h, lane)?.timeMs,
    27_150,
    "discarding one leaves the other two to be averaged",
  );

  /* How a time arrived is the timestamps, not a field repeating them. */
  eq(
    rows.watches.map(fromStopwatch),
    [true, true, false],
    "a watch came off a stopwatch exactly when it carries both timestamps",
  );
  eq(
    resultForLane(rows, h, lane)?.manual,
    false,
    "a result with any stopwatch behind it is not hand-entered",
  );
  eq(
    resultForLane(
      { watches: [rows.watches[2]], calls: [] },
      h,
      lane,
    )?.manual,
    true,
    "one typed in on its own is",
  );

  // Who took it survives the round trip, which is what lets a screen say
  // "typed in at the desk" rather than a device id nobody recognises.
  eq(
    rows.watches.filter((w) => w.userId !== undefined).length,
    2,
    "watches from signed-in people carry the account",
  );
  eq(
    rows.watches.find((w) => w.timerId === "d-phone")?.userId,
    undefined,
    "and a phone behind a lane carries none",
  );
}

done();

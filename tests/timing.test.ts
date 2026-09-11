import { done, eq } from "./harness.ts";
import { acceptResult, activeLanes, attributedAthlete, eventClosed, heatClosed, heatProgress, makeRuling, makeWatch, officialTime, resultForLane, resultsForHeat, truncateToHundredths, watchesForLane } from "../app/lib/timing.ts";
import { watchId, type Heat } from "../app/types/meet.ts";

/* ------------------------------------------------ timing */

const w = (timeMs: number, timerId = "t" + timeMs, source: "stopwatch" | "typed" = "stopwatch") => ({
  id: watchId("h1", 3, timerId), eventId: "e1", heatId: "h1", lane: 3, timerId, timeMs, recordedAt: 1000 + timeMs, source,
});

/* ---- truncation, not rounding ---- */
eq(truncateToHundredths(27145), 27140, "27.145 truncates to 27.14");
eq(truncateToHundredths(27149), 27140, "27.149 truncates too");
eq(truncateToHundredths(27140), 27140, "an exact hundredth is untouched");
eq(truncateToHundredths(0), 0, "zero");

/* ---- the hand-timing rules ---- */
eq(officialTime([]), null, "no watches, no time");
eq(officialTime([w(27130)]), { timeMs: 27130, method: "single", watchCount: 1 }, "one watch stands alone");
eq(officialTime([w(27130), w(27160)]), { timeMs: 27140, method: "average", watchCount: 2 },
   "two watches average, truncated: 27.13 + 27.16 -> 27.145 -> 27.14");
eq(officialTime([w(27130), w(27150)]), { timeMs: 27140, method: "average", watchCount: 2 }, "an exact average needs no truncation");
eq(officialTime([w(27130), w(27160), w(27140)]), { timeMs: 27140, method: "median", watchCount: 3 },
   "three watches take the middle one");
eq(officialTime([w(27500), w(27130), w(27140)]), { timeMs: 27140, method: "median", watchCount: 3 },
   "a slow thumb is outvoted rather than averaged in");
eq(officialTime([w(27130), w(27140), w(27150), w(27180)]), { timeMs: 27140, method: "median", watchCount: 4 },
   "four watches average the middle pair, truncated: 27.14 + 27.15 -> 27.145 -> 27.14");

// Order of arrival must not matter — timers finish in any order.
eq(officialTime([w(27160), w(27130), w(27140)])?.timeMs, officialTime([w(27130), w(27140), w(27160)])?.timeMs,
   "the answer doesn't depend on who reported first");

/* ---- deterministic ids: a retry is not a duplicate ---- */
const heat = { id: "h1", eventId: "e1", index: 0, lanes: [null, null, "swimmerA", null, null, null] };
const first = makeWatch(heat, 3, "deviceA", 27130, "stopwatch");
const retry = makeWatch(heat, 3, "deviceA", 27130, "stopwatch");
eq(first.id, retry.id, "the same timer on the same lane keeps the same id");
eq(makeWatch(heat, 3, "deviceB", 27160, "stopwatch").id !== first.id, true, "a different timer is a different watch");
eq(makeWatch(heat, 4, "deviceA", 27160, "stopwatch").id !== first.id, true, "so is a different lane");

/* ---- results derived from watches ---- */
const meet = (watches: any[], rulings: any[] = [], results: any[] = []) => ({
  watches,
  rulings,
  results,
});

eq(resultForLane(meet([]), heat, 3), null, "a lane with nothing recorded has no result");
eq(resultForLane(meet([]), heat, 1), null, "an empty lane never has one");

const three = meet([w(27130, "a"), w(27160, "b"), w(27140, "c")]);
const r = resultForLane(three, heat, 3)!;
eq(r.timeMs, 27140, "three watches give the middle time");
eq(r.status, "OK", "and no ruling means OK");
eq(r.method, "median", "reported as a median");
eq(r.watchCount, 3, "with the count that stood behind it");
eq(r.athleteId, "swimmerA", "attributed to whoever was in the lane");
eq(r.manual, false, "stopwatch times aren't manual");

eq(resultForLane(meet([w(27130, "a", "typed")]), heat, 3)!.manual, true, "a typed time is manual");

/* ---- rulings outrank watches ---- */
const dq = meet([w(27130, "a"), w(27140, "b")], [makeRuling(heat, 3, "DQ")]);
eq(resultForLane(dq, heat, 3)!.status, "DQ", "a DQ stands over the watches");
eq(resultForLane(dq, heat, 3)!.timeMs, 27130, "and the time is still worked out, for the record");

const override = meet([w(27130, "a"), w(27140, "b")], [makeRuling(heat, 3, "OK", 26990)]);
const o = resultForLane(override, heat, 3)!;
eq(o.timeMs, 26990, "a coach's own time replaces the watches");
eq(o.method, "official", "and says so");
eq(o.watchCount, 2, "while still reporting what it overrode");

const noShow = meet([], [makeRuling(heat, 3, "NS")]);
eq(resultForLane(noShow, heat, 3)!.status, "NS", "a no-show needs no watch at all");
eq(resultForLane(noShow, heat, 3)!.watchCount, 0, "with no watches behind it");

/* ---- a whole heat ---- */
const busy = {
  watches: [
    { ...w(27130, "a"), lane: 3 }, { ...w(27160, "b"), lane: 3 },
    { ...w(30010, "a"), lane: 4, id: watchId("h1", 4, "a") },
  ],
  rulings: [],
  results: [],
};
const heat2 = { id: "h1", eventId: "e1", index: 0, lanes: [null, null, "swimmerA", "swimmerB", null, null] };
const results = resultsForHeat(busy, heat2);
eq(results.length, 2, "one result per timed lane");
eq(results.map((x) => x.lane), [3, 4], "in lane order");
eq(results[0].timeMs, 27140, "lane 3 averaged and truncated");
eq(results[1].timeMs, 30010, "lane 4 single");

/* ------------------------------- an empty lane the timers had an opinion on */

// The gap this closes: a visiting swimmer, an exhibition swim, or a late entry
// nobody seeded. The lineup has no opinion about an empty lane, so the timers
// are the only witnesses — and silently dropping a swim that genuinely
// happened is worse than crediting it on their word.
{
  const heat: Heat = {
    id: "h9",
    eventId: "ev1",
    index: 0,
    lanes: ["a1", null, null, null, null, null],
  };
  const meet = {
    heats: [heat],
    rulings: [],
    results: [],
    watches: [
      { id: "h9:1:tA", eventId: "ev1", heatId: "h9", lane: 1, timerId: "tA", timeMs: 26100, recordedAt: 1, source: "stopwatch" as const },
      // Lane 4 was empty; two timers say Dana swam it.
      { id: "h9:4:tA", eventId: "ev1", heatId: "h9", lane: 4, timerId: "tA", timeMs: 25400, recordedAt: 2, source: "stopwatch" as const, athleteId: "a9" },
      { id: "h9:4:tB", eventId: "ev1", heatId: "h9", lane: 4, timerId: "tB", timeMs: 25460, recordedAt: 3, source: "stopwatch" as const, athleteId: "a9" },
    ],
  };

  const lane4 = resultForLane(meet, heat, 4)!;
  eq(lane4 !== null, true, "an unseeded lane the timers named still produces a result");
  eq(lane4.athleteId, "a9", "credited to whoever the timers said");
  eq(lane4.attributed, true, "and flagged, because nobody seeded it");
  eq(lane4.watchCount, 2, "with both watches behind it");

  const lane1 = resultForLane(meet, heat, 1)!;
  eq(lane1.athleteId, "a1", "a seeded lane is unaffected");
  eq(lane1.attributed, undefined, "and isn't flagged");

  // The lineup still wins where it has an opinion: a timer may not move a
  // swimmer out of a lane the coach seeded.
  const disputed = {
    ...meet,
    watches: [
      { id: "h9:1:tA", eventId: "ev1", heatId: "h9", lane: 1, timerId: "tA", timeMs: 26100, recordedAt: 1, source: "stopwatch" as const, athleteId: "a9" },
    ],
  };
  eq(
    resultForLane(disputed, heat, 1)!.athleteId,
    "a1",
    "a timer disagreeing about a seeded lane does not rewrite the lineup",
  );

  eq(resultForLane(meet, heat, 5), null, "an empty lane nobody named is still nothing");
}

/* ---- who the timers name, when they disagree ---- */
{
  const w = (timerId: string, athleteId: string | undefined, recordedAt: number) => ({
    id: `x:${timerId}`, eventId: "ev1", heatId: "h9", lane: 4, timerId,
    timeMs: 25000, recordedAt, source: "stopwatch" as const, athleteId,
  });

  eq(attributedAthlete([]), undefined, "no watches, nobody named");
  eq(attributedAthlete([w("tA", undefined, 1)]), undefined, "a watch naming nobody names nobody");
  eq(attributedAthlete([w("tA", "a9", 1)]), "a9", "one timer's word stands alone");
  eq(
    attributedAthlete([w("tA", "a9", 1), w("tB", "a9", 2), w("tC", "a7", 3)]),
    "a9",
    "the most-named wins",
  );
  eq(
    attributedAthlete([w("tB", "a7", 5), w("tA", "a9", 2)]),
    "a9",
    "an even split goes to whoever reported first, so the answer is stable",
  );
  eq(
    attributedAthlete([w("tA", "a9", 2), w("tB", "a7", 5)]),
    "a9",
    "and doesn't depend on the order the watches arrived in",
  );
}

/* ------------------------------------------------ accepting a lane's result */

// The layering the whole design rests on: watches are evidence, rulings are
// judgements, and an accepted result is the decision. Nothing is official
// until an administrator says so.
{
  const h: Heat = {
    id: "hA", eventId: "e1", index: 0,
    lanes: ["s1", "s2", null, null, null, null],
  };
  const base = {
    heats: [h],
    rulings: [],
    results: [] as any[],
    watches: [
      { id: "hA:1:t1", eventId: "e1", heatId: "hA", lane: 1, timerId: "t1", timeMs: 27130, recordedAt: 10, source: "stopwatch" as const },
      { id: "hA:1:t2", eventId: "e1", heatId: "hA", lane: 1, timerId: "t2", timeMs: 27150, recordedAt: 11, source: "stopwatch" as const },
      { id: "hA:2:t1", eventId: "e1", heatId: "hA", lane: 2, timerId: "t1", timeMs: 30000, recordedAt: 12, source: "stopwatch" as const },
    ],
  };

  eq(resultForLane(base, h, 1)!.accepted, undefined, "a computed time is a proposal, not a result");
  eq(heatClosed(base, h), false, "and the heat is open");
  eq(eventClosed(base, "e1"), false, "so is the event");
  eq(heatProgress(base, h), { accepted: 0, active: 2 }, "two lanes swam, none accepted");

  // Accept lane 1 as it stands.
  const one = acceptResult(base, h, 1, "admin")!;
  eq(one.timeMs, 27140, "accepting takes what the watches worked out");
  eq(one.athleteId, "s1", "credited to whoever was in the lane");
  eq(one.fromWatches, { timeMs: 27140, watchCount: 2, method: "average" }, "and records what it saw");

  const after = { ...base, results: [one] };
  eq(resultForLane(after, h, 1)!.accepted, true, "now it's official");
  eq(heatClosed(after, h), false, "but lane 2 is still outstanding");

  // The case acceptance exists for: a watch arriving after the fact.
  const late = {
    ...after,
    watches: [
      ...base.watches,
      { id: "hA:1:t3", eventId: "e1", heatId: "hA", lane: 1, timerId: "t3", timeMs: 99999, recordedAt: 900, source: "stopwatch" as const },
    ],
  };
  eq(
    resultForLane(late, h, 1)!.timeMs,
    27140,
    "a watch that turns up afterwards doesn't move an accepted result",
  );
  eq(
    watchesForLane(late, "hA", 1).length,
    3,
    "though it's still on file, timestamped, for anyone who wants to reopen it",
  );

  // An administrator disagreeing is the other half of accepting.
  const corrected = acceptResult(base, h, 2, "admin", { timeMs: 29990, status: "DQ" })!;
  eq(corrected.timeMs, 29990, "a correction is what gets stored");
  eq(corrected.status, "DQ", "with the status they chose");
  eq(corrected.fromWatches?.timeMs, 30000, "and what it overrode, for the record");

  const closed = { ...base, results: [one, corrected] };
  eq(heatClosed(closed, h), true, "every lane that swam is accepted, so the heat is closed");
  eq(eventClosed(closed, "e1"), true, "and its only heat is closed, so the event is official");
  eq(heatProgress(closed, h), { accepted: 2, active: 2 }, "both accepted");
}

/* ---- an unseeded lane a timer named still has to be accepted ---- */
{
  const h: Heat = { id: "hB", eventId: "e2", index: 0, lanes: ["s1", null, null, null, null, null] };
  const meet = {
    heats: [h],
    rulings: [],
    results: [] as any[],
    watches: [
      { id: "hB:1:t1", eventId: "e2", heatId: "hB", lane: 1, timerId: "t1", timeMs: 27000, recordedAt: 1, source: "stopwatch" as const },
      { id: "hB:4:t1", eventId: "e2", heatId: "hB", lane: 4, timerId: "t1", timeMs: 26000, recordedAt: 2, source: "stopwatch" as const, athleteId: "visitor" },
    ],
  };
  eq(activeLanes(meet, h), [1, 4], "a lane a timer put a name to counts as swum");
  eq(heatClosed(meet, h), false, "so it holds the heat open until it's accepted too");

  const both = {
    ...meet,
    results: [acceptResult(meet, h, 1, "a")!, acceptResult(meet, h, 4, "a")!],
  };
  eq(heatClosed(both, h), true, "accepting both closes it");
  eq(
    both.results[1].athleteId,
    "visitor",
    "and the unseeded swim stays credited to whoever the timer named",
  );

  // An empty lane nobody claimed isn't waiting on anything.
  const quiet = { ...meet, watches: [meet.watches[0]] };
  eq(activeLanes(quiet, h), [1], "an untouched empty lane doesn't count");
}

/* ------------------------ a time entered by hand is a claim, not a decision */

// The distinction that matters: an official saying "the time was 2:04.55" and
// an official saying "this lane is final" are different acts. Folding the
// first into the second meant undoing a sign-off threw the reading away.
{
  const h: Heat = { id: "hC", eventId: "e3", index: 0, lanes: ["s1", null, null, null, null, null] };
  const watches = [
    { id: "hC:1:t1", eventId: "e3", heatId: "hC", lane: 1, timerId: "t1", timeMs: 30000, recordedAt: 1, source: "stopwatch" as const },
  ];

  const raw = { heats: [h], watches, rulings: [] as any[], results: [] as any[] };
  eq(resultForLane(raw, h, 1)!.timeMs, 30000, "with nothing else, the watch stands");

  // The official reads the pad differently and says so.
  const called = {
    ...raw,
    rulings: [makeRuling(h, 1, "OK", 29870, "admin-1")],
  };
  const proposed = resultForLane(called, h, 1)!;
  eq(proposed.timeMs, 29870, "a time entered by hand outranks the watches");
  eq(proposed.accepted, undefined, "but entering one is not signing the lane off");
  eq(called.rulings[0].decidedBy, "admin-1", "and the record says who made the call");

  // Now sign it off, and take the sign-off back.
  const accepted = acceptResult(called, h, 1, "admin-1")!;
  eq(accepted.timeMs, 29870, "accepting takes the call, not the raw watch");

  const undone = { ...called, results: [] };
  eq(
    resultForLane(undone, h, 1)!.timeMs,
    29870,
    "undoing the sign-off returns to the official's reading, not to the watches",
  );

  // Status and time are two facts about one lane; neither should erase the
  // other. Marking a DQ after entering a time must keep the time.
  const dq = makeRuling(h, 1, "DQ", called.rulings[0].timeMs, "admin-1");
  eq(dq.timeMs, 29870, "a DQ keeps the time that was entered");
  eq(dq.status, "DQ", "and carries the ruling");
  eq(
    resultForLane({ ...raw, rulings: [dq] }, h, 1)!.status,
    "DQ",
    "which is what the lane then reads as",
  );
}

done();

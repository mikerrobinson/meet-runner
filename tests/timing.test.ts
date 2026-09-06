import { done, eq } from "./harness.ts";
import { makeRuling, makeWatch, officialTime, resultForLane, resultsForHeat, truncateToHundredths } from "../app/lib/timing.ts";
import { watchId } from "../app/types/meet.ts";

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
const meet = (watches: any[], rulings: any[] = []) => ({ watches, rulings });

eq(resultForLane(meet([]), heat, 3), null, "a lane with nothing recorded has no result");
eq(resultForLane(meet([]), heat, 1), null, "an empty lane never has one");

const three = meet([w(27130, "a"), w(27160, "b"), w(27140, "c")]);
const r = resultForLane(three, heat, 3)!;
eq(r.timeMs, 27140, "three watches give the middle time");
eq(r.status, "OK", "and no ruling means OK");
eq(r.method, "median", "reported as a median");
eq(r.watchCount, 3, "with the count that stood behind it");
eq(r.swimmerId, "swimmerA", "attributed to whoever was in the lane");
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
};
const heat2 = { id: "h1", eventId: "e1", index: 0, lanes: [null, null, "swimmerA", "swimmerB", null, null] };
const results = resultsForHeat(busy, heat2);
eq(results.length, 2, "one result per timed lane");
eq(results.map((x) => x.lane), [3, 4], "in lane order");
eq(results[0].timeMs, 27140, "lane 3 averaged and truncated");
eq(results[1].timeMs, 30010, "lane 4 single");

done();

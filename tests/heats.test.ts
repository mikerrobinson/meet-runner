import { done, eq } from "./harness.ts";
import { buildHeats, laneOrder, reseedHeats } from "../app/lib/heats.ts";
import type { Heat, LaneCall, Watch } from "../app/types/meet.ts";

/* ------------------------------------------------ lanes */

// The three that were hard-coded before must come out unchanged.
eq(laneOrder(4), [2, 3, 1, 4], "4 lanes");
eq(laneOrder(6), [3, 4, 2, 5, 1, 6], "6 lanes");
eq(laneOrder(8), [4, 5, 3, 6, 2, 7, 1, 8], "8 lanes");
eq(laneOrder(5), [3, 2, 4, 1, 5], "5 lanes");
eq(laneOrder(10), [5, 6, 4, 7, 3, 8, 2, 9, 1, 10], "10 lanes");

for (const n of [4, 5, 6, 8, 10] as const) {
  const order = laneOrder(n);
  eq([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1), `${n} lanes: every lane once`);
}

// 13 swimmers in a 10-lane pool: short heat first, seeded from the middle.
const heats = buildHeats("m1", "e1", Array.from({ length: 13 }, (_, i) => `s${i + 1}`), 10);
eq(heats.length, 2, "13 in a 10-lane pool makes 2 heats");
eq(heats[0].lanes.filter(Boolean).length, 3, "short heat first");
eq(heats[0].lanes, [null, null, null, "s3", "s1", "s2", null, null, null, null], "top seeds centred (5, 6, 4)");
eq(heats[1].lanes.filter(Boolean).length, 10, "full heat second");

// 7 in a 5-lane pool.
const five = buildHeats("m1", "e2", Array.from({ length: 7 }, (_, i) => `s${i + 1}`), 5);
eq(five.length, 2, "7 in a 5-lane pool makes 2 heats");
eq(five[0].lanes, [null, "s2", "s1", null, null], "5-lane short heat seeds 3 then 2");

/* --------------------------------------------- reseeding */

// Reseeding used to mint fresh heat ids and delete the event's times to make
// room. Both are tested here because both were real: the first orphaned every
// seat and call pointing at the old heat, the second deleted other people's
// watches from one device and synced the deletion to the rest.
{
  const seeded = buildHeats("m1", "e1", ["s1", "s2", "s3", "s4", "s5", "s6", "s7"], 6);
  const base = {
    heats: seeded,
    watches: [] as Watch[],
    calls: [] as LaneCall[],
  };

  const again = reseedHeats(base, "m1", "e1", ["s7", "s6", "s5", "s4", "s3", "s2", "s1"], 6);
  eq(again !== null, true, "an untouched event reseeds");
  eq(again!.map((h) => h.id), seeded.map((h) => h.id), "heat ids are reused in place");
  eq(again!.length, 2, "still two heats");
  eq(again![0].lanes.filter(Boolean), ["s7"], "and the order actually changed");

  // One watch anywhere in the event is enough.
  const timed = {
    ...base,
    watches: [
      {
        heatId: seeded[1].id,
        lane: 3,
        timerId: "t1",
        timeMs: 27_140,
        recordedAt: 1,
        source: "stopwatch" as const,
      },
    ],
  };
  eq(reseedHeats(timed, "m1", "e1", ["s1"], 6), null, "an event with a time on it refuses");

  // A call with no watch behind it is still a record of the heat.
  const dq = {
    ...base,
    calls: [
      { heatId: seeded[0].id, lane: 2, status: "DQ", final: false, decidedAt: 2 },
    ] as LaneCall[],
  };
  eq(reseedHeats(dq, "m1", "e1", ["s1"], 6), null, "so does an event with only a DQ on it");

  // Another event's times are no business of this one.
  const elsewhere = {
    ...base,
    watches: [
      {
        heatId: "other",
        lane: 3,
        timerId: "t1",
        timeMs: 27_140,
        recordedAt: 1,
        source: "stopwatch" as const,
      },
    ],
  };
  eq(
    reseedHeats(elsewhere, "m1", "e1", ["s1"], 6) !== null,
    true,
    "another event's times don't block it",
  );
}

done();

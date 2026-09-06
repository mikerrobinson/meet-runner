import { done, eq } from "./harness.ts";
import { buildHeats, laneOrder } from "../app/lib/heats.ts";

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
const heats = buildHeats("e1", Array.from({ length: 13 }, (_, i) => `s${i + 1}`), 10);
eq(heats.length, 2, "13 in a 10-lane pool makes 2 heats");
eq(heats[0].lanes.filter(Boolean).length, 3, "short heat first");
eq(heats[0].lanes, [null, null, null, "s3", "s1", "s2", null, null, null, null], "top seeds centred (5, 6, 4)");
eq(heats[1].lanes.filter(Boolean).length, 10, "full heat second");

// 7 in a 5-lane pool.
const five = buildHeats("e2", Array.from({ length: 7 }, (_, i) => `s${i + 1}`), 5);
eq(five.length, 2, "7 in a 5-lane pool makes 2 heats");
eq(five[0].lanes, [null, "s2", "s1", null, null], "5-lane short heat seeds 3 then 2");

done();

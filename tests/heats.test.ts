import { done, eq } from "./harness.ts";
import { buildSeeds, laneOrder, reseedEvent } from "../app/lib/heats.ts";
import type { Result, Seed, Watch } from "../app/types/meet.ts";

/* ------------------------------------------------ lanes */

// The three that were hard-coded before must come out unchanged.
eq(laneOrder(4), [2, 3, 1, 4], "4 lanes");
eq(laneOrder(6), [3, 4, 2, 5, 1, 6], "6 lanes");
eq(laneOrder(8), [4, 5, 3, 6, 2, 7, 1, 8], "8 lanes");
eq(laneOrder(5), [3, 2, 4, 1, 5], "5 lanes");
eq(laneOrder(10), [5, 6, 4, 7, 3, 8, 2, 9, 1, 10], "10 lanes");

for (const n of [4, 5, 6, 8, 10] as const) {
  const order = laneOrder(n);
  eq(
    [...order].sort((a, b) => a - b),
    Array.from({ length: n }, (_, i) => i + 1),
    `${n} lanes: every lane once`,
  );
}

/* ------------------------------------------------ seeding */

// 13 swimmers in a 10-lane pool: short heat first, seeded from the middle.
{
  const seeds = buildSeeds("m1", "e1", Array.from({ length: 13 }, (_, i) => `s${i + 1}`), 10);
  const heats = [...new Set(seeds.map((s) => s.heat))];

  eq(heats, [1, 2], "13 in a 10-lane pool makes 2 heats, numbered from 1");
  eq(seeds.filter((s) => s.heat === 1).length, 3, "short heat first");
  eq(
    seeds.filter((s) => s.heat === 1).map((s) => `${s.lane}:${s.athleteId}`),
    ["5:s1", "6:s2", "4:s3"],
    "top seeds centred (5, 6, 4)",
  );
  eq(seeds.filter((s) => s.heat === 2).length, 10, "full heat second");
  // A lane nobody is in is not a row: a heat is what is actually in it.
  eq(seeds.length, 13, "one seed per swimmer, and none for the empty lanes");
}

{
  const five = buildSeeds("m1", "e2", Array.from({ length: 7 }, (_, i) => `s${i + 1}`), 5);
  eq([...new Set(five.map((s) => s.heat))], [1, 2], "7 in a 5-lane pool makes 2 heats");
  eq(
    five.filter((s) => s.heat === 1).map((s) => `${s.lane}:${s.athleteId}`),
    ["3:s1", "2:s2"],
    "5-lane short heat seeds 3 then 2",
  );
}

eq(buildSeeds("m1", "e3", [], 6), [], "nobody entered, nothing to seed");

/* ------------------------------------------------ reseeding */

{
  const seeded = buildSeeds("m1", "e1", ["s1", "s2", "s3", "s4", "s5", "s6", "s7"], 6);
  const base = { seeds: seeded, watches: [] as Watch[], results: [] as Result[] };

  const again = reseedEvent(base, "m1", "e1", ["s7", "s6", "s5", "s4", "s3", "s2", "s1"], 6);
  eq(again !== null, true, "an untouched event reseeds");
  eq(again!.length, 7, "still seven swims");
  eq(
    again!.filter((s) => s.heat === 1).map((s) => s.athleteId),
    ["s7"],
    "and the order actually changed",
  );

  // Somebody who lands back in the lane they were in keeps their row, so a
  // watch already taken on it would still point at the right swim.
  const stayed = reseedEvent(base, "m1", "e1", ["s1", "s2", "s3", "s4", "s5", "s6", "s7"], 6);
  eq(
    stayed!.map((s) => s.id).sort(),
    seeded.map((s) => s.id).sort(),
    "an unchanged reseeding reuses every id",
  );

  // One watch anywhere in the event is enough to stop it.
  const timed = {
    ...base,
    watches: [
      { seedId: seeded[1].id, timerId: "t1", role: "timer" as const, timeMs: 27_140, recordedAt: 1 },
    ],
  };
  eq(reseedEvent(timed, "m1", "e1", ["s1"], 6), null, "an event with a time on it refuses");

  // A result with no watch behind it is still a record of the swim.
  const dq = {
    ...base,
    results: [
      {
        seedId: seeded[0].id,
        meetId: "m1",
        eventId: "e1",
        athleteId: "s1",
        status: "DQ" as const,
        timeMs: 0,
        decidedAt: 2,
      },
    ],
  };
  eq(reseedEvent(dq, "m1", "e1", ["s1"], 6), null, "so does an event with only a DQ on it");

  // Another event's times are no business of this one.
  const elsewhere = {
    ...base,
    watches: [
      { seedId: "other", timerId: "t1", role: "timer" as const, timeMs: 27_140, recordedAt: 1 },
    ],
  };
  eq(
    reseedEvent(elsewhere, "m1", "e1", ["s1"], 6) !== null,
    true,
    "another event's times don't block it",
  );
}

done();

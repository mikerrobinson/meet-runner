import { done, eq } from "./harness.ts";
import {
  athleteSwims,
  meetResults,
  meetSummary,
  publicAthlete,
  publicAthletes,
  teamRef,
} from "../app/lib/public.ts";
import { createMeetDoc, createTeam } from "../app/lib/documents.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { buildHeats } from "../app/lib/heats.ts";
import { makeEnrollment, makeSeason } from "../app/lib/roster.ts";
import type { Athlete, TeamDoc } from "../app/types/meet.ts";

/* ------------------------------------------------------------- redaction */

// The whole point of the module: a birth date must not be able to get out,
// and the test says so by listing what may travel rather than what may not.
{
  const avery: Athlete = {
    id: "a1",
    firstName: "Avery",
    lastName: "Nguyen",
    gender: "F",
    birthDate: "2009-03-14",
    userId: "u1",
  };

  const shown = publicAthlete(avery);
  eq(
    Object.keys(shown).sort(),
    ["firstName", "gender", "id", "lastName"],
    "a public athlete is exactly four fields",
  );
  eq("birthDate" in shown, false, "a minor's birth date never travels");
  eq("userId" in shown, false, "nor does the account behind them");
  eq(
    JSON.stringify(publicAthletes([avery])).includes("2009"),
    false,
    "and it isn't hiding in the serialised form either",
  );
}

/* ------------------------------------------------------- a meet, publicly */

const home: TeamDoc = (() => {
  const base = createTeam("Cactus Shadows");
  const season = makeSeason(base.id, "2026-27", {
    startDate: "2026-08-01",
    endDate: "2027-07-31",
  });
  return {
    ...base,
    code: "CHAP",
    seasons: [season],
    currentSeasonId: season.id,
    enrollments: [
      makeEnrollment(base.id, season.id, "a1", { year: "10" }),
      makeEnrollment(base.id, season.id, "a2", { year: "11" }),
    ],
  };
})();

const away: TeamDoc = (() => {
  const base = createTeam("Horizon");
  const season = makeSeason(base.id, "2026-27", {
    startDate: "2026-08-01",
    endDate: "2027-07-31",
  });
  return {
    ...base,
    code: "HRZN",
    seasons: [season],
    currentSeasonId: season.id,
    enrollments: [makeEnrollment(base.id, season.id, "a9", { year: "12" })],
  };
})();

const athletes: Athlete[] = [
  { id: "a1", firstName: "Avery", lastName: "Nguyen", gender: "F", birthDate: "2009-03-14" },
  { id: "a2", firstName: "Marcus", lastName: "Hill", gender: "M" },
  { id: "a9", firstName: "Dana", lastName: "Reyes", gender: "F" },
];

const events = defaultEvents({ course: "SCY" });
const free50 = events.find((e) => e.distance === 50 && e.stroke === "Free")!;
const heats = buildHeats(free50.id, ["a1", "a9", "a2"], 6);
const lanes = heats[0].lanes;
const laneOf = (id: string) => lanes.indexOf(id) + 1;

const meet = createMeetDoc([home.id, away.id], {
  name: "vs Horizon",
  date: "2026-11-14",
  course: "SCY",
  hostTeamId: home.id,
  events,
  entries: { [free50.id]: ["a1", "a9", "a2"] },
  heats,
  watches: [
    // Dana is fastest, Avery second, Marcus is disqualified.
    { id: "w1", eventId: free50.id, heatId: heats[0].id, lane: laneOf("a9"), timerId: "t1", timeMs: 25400, recordedAt: 1, source: "stopwatch" },
    { id: "w2", eventId: free50.id, heatId: heats[0].id, lane: laneOf("a1"), timerId: "t1", timeMs: 26100, recordedAt: 2, source: "stopwatch" },
    { id: "w3", eventId: free50.id, heatId: heats[0].id, lane: laneOf("a2"), timerId: "t1", timeMs: 24900, recordedAt: 3, source: "stopwatch" },
  ],
  rulings: [
    { id: `${heats[0].id}:${laneOf("a2")}`, eventId: free50.id, heatId: heats[0].id, lane: laneOf("a2"), status: "DQ" as const, decidedAt: 4 },
  ],
  timer: null,
});

/* ---- summary ---- */
{
  const summary = meetSummary(meet, [home, away]);
  eq(summary.teams.map((t) => t.code), ["CHAP", "HRZN"], "both teams are named");
  eq(summary.hostTeamId, home.id, "and the host is known");
  eq(summary.entries, 3, "three entries");
  eq(summary.times, 3, "three lanes with something recorded");
  eq(summary.events, events.length, "the whole lineup is counted");

  // A team the meet names but this device has never heard of is dropped
  // rather than rendered as a blank chip.
  eq(
    meetSummary(meet, [home]).teams.map((t) => t.code),
    ["CHAP"],
    "a team we don't hold is left out rather than shown empty",
  );
}

/* ---- results ---- */
{
  const teamOf = (id: string) =>
    home.enrollments.some((e) => e.athleteId === id)
      ? teamRef(home)
      : away.enrollments.some((e) => e.athleteId === id)
        ? teamRef(away)
        : null;

  const byEvent = meetResults(meet, athletes, teamOf);
  const race = byEvent.find((e) => e.id === free50.id)!;

  eq(
    race.placings.map((p) => p.athlete?.firstName),
    ["Dana", "Avery", "Marcus"],
    "ranked by time across the heat, with the DQ last",
  );
  eq(
    race.placings.map((p) => p.place),
    [1, 2, null],
    "a disqualified swim keeps its line and loses its place",
  );
  eq(race.placings[0].team?.code, "HRZN", "each swim is credited to the right team");
  eq(race.placings[1].team?.code, "CHAP", "on both sides of the meet");
  eq(
    JSON.stringify(byEvent).includes("2009-03-14"),
    false,
    "no birth date reaches a results page",
  );

  // Diving holds its place in the running order and carries no times.
  const diving = byEvent.find((e) => e.stroke === "Diving");
  if (diving) eq(diving.placings, [], "diving is listed but never scored here");
}

/* ---- one athlete's history ---- */
{
  const second = createMeetDoc([home.id], {
    name: "vs Central",
    date: "2027-01-10",
    course: "SCY",
    events,
    entries: { [free50.id]: ["a1"] },
    heats: buildHeats(free50.id, ["a1"], 6),
    timer: null,
  });
  const faster = {
    ...second,
    watches: [
      {
        id: "w9",
        eventId: free50.id,
        heatId: second.heats[0].id,
        lane: second.heats[0].lanes.indexOf("a1") + 1,
        timerId: "t1",
        timeMs: 25800,
        recordedAt: 5,
        source: "stopwatch" as const,
      },
    ],
  };

  const swims = athleteSwims("a1", [meet, faster]);
  eq(swims.length, 2, "both of Avery's swims");
  eq(swims[0].date, "2027-01-10", "newest first");
  eq(swims.map((s) => s.best), [true, false], "the faster one is the best");
  eq(swims[0].timeMs, 25800, "and it's the one that actually was faster");

  // A time in another pool length is a different record entirely.
  const metric = { ...faster, id: "m3", course: "LCM" as const, date: "2027-02-01" };
  const mixed = athleteSwims("a1", [meet, faster, metric]);
  eq(
    mixed.filter((s) => s.best).length,
    2,
    "a best per course, since a yard time and a metre time aren't comparable",
  );

  eq(athleteSwims("nobody", [meet]), [], "someone who never swam has no history");
}

done();

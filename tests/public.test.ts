import { done, eq } from "./harness.ts";
import {
  athleteSwims,
  meetResults,
  meetSummary,
  publicAthlete,
  publicAthletes,
  teamRef,
} from "../app/lib/public.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { buildHeats } from "../app/lib/heats.ts";
import { makeEnrollment } from "../app/lib/roster.ts";
import type {
  Athlete,
  LaneCall,
  Meet,
  MeetDetail,
  Team,
  Watch,
} from "../app/types/meet.ts";

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
    "only a name and a gender travel",
  );
  eq(
    JSON.stringify(publicAthletes([avery])).includes("2009-03-14"),
    false,
    "and it isn't hiding in the serialised form either",
  );
  eq(
    JSON.stringify(publicAthletes([avery])).includes("u1"),
    false,
    "nor is the account behind them",
  );
}

/* ------------------------------------------------------- a meet, publicly */

const home: Team = { id: "t1", name: "Cactus Shadows", code: "CHAP" };
const away: Team = { id: "t2", name: "Horizon", code: "HRZN" };

const athletes: Athlete[] = [
  { id: "a1", firstName: "Avery", lastName: "Nguyen", gender: "F", birthDate: "2009-03-14" },
  { id: "a2", firstName: "Marcus", lastName: "Hill", gender: "M" },
  { id: "a9", firstName: "Dana", lastName: "Reyes", gender: "F" },
];

const events = defaultEvents("m1", { course: "SCY" });
const free50 = events.find((e) => e.distance === 50 && e.stroke === "Free")!;
const heats = buildHeats("m1", free50.id, ["a1", "a9", "a2"], 6);
const lanes = heats[0].lanes;
const laneOf = (id: string) => lanes.indexOf(id) + 1;

const meetRow: Meet = {
  id: "m1",
  name: "vs Horizon",
  date: "2026-11-14",
  type: "dual",
  course: "SCY",
  teamIds: [home.id, away.id],
  hostTeamId: home.id,
  laneCount: 6,
  leadGender: "F",
  includeDiving: true,
  limits: {},
  entryVisibility: "everyone",
  athletesMayEnter: false,
};

const watch = (lane: number, timeMs: number, at: number): Watch => ({
  heatId: heats[0].id,
  lane,
  timerId: "t1",
  timeMs,
  recordedAt: at,
  source: "stopwatch",
});

const detail: MeetDetail = {
  meet: meetRow,
  teams: [home, away],
  events,
  entries: { [free50.id]: ["a1", "a9", "a2"] },
  heats,
  // Dana is fastest, Avery second, Marcus is disqualified.
  watches: [
    watch(laneOf("a9"), 25_400, 1),
    watch(laneOf("a1"), 26_100, 2),
    watch(laneOf("a2"), 24_900, 3),
  ],
  calls: [
    {
      heatId: heats[0].id,
      lane: laneOf("a2"),
      status: "DQ",
      final: false,
      decidedAt: 4,
    },
  ] as LaneCall[],
  athletes,
  enrollments: [
    makeEnrollment(home.id, "s1", "a1", { year: "10" }),
    makeEnrollment(home.id, "s1", "a2", { year: "11" }),
    makeEnrollment(away.id, "s2", "a9", { year: "12" }),
  ],
};

/* ---- summary ---- */
{
  const summary = meetSummary(detail.meet, detail.teams, {
    events: events.length,
    entries: 3,
    times: 3,
  });
  eq(summary.teams.map((t) => t.code), ["CHAP", "HRZN"], "both teams are named");
  eq(summary.hostTeamId, home.id, "and the host is known");
  eq(summary.entries, 3, "three entries");
  eq(summary.times, 3, "three lanes with something recorded");
  eq(summary.events, events.length, "the whole lineup is counted");
}

/* ---- results ---- */
{
  const teamOf = (id: string) => {
    const enrolled = detail.enrollments.find((e) => e.athleteId === id);
    if (!enrolled) return null;
    return enrolled.teamId === home.id ? teamRef(home) : teamRef(away);
  };

  const byEvent = meetResults(detail, teamOf);
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
  eq(race.official, false, "nothing is signed off, so the event isn't official");
  eq(race.placings.every((p) => p.final === false), true, "and no placing claims to be");
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
  const secondHeats = buildHeats("m2", free50.id, ["a1"], 6);
  const faster: MeetDetail = {
    ...detail,
    meet: { ...meetRow, id: "m2", name: "vs Central", date: "2027-01-10" },
    heats: secondHeats,
    entries: { [free50.id]: ["a1"] },
    calls: [],
    watches: [
      {
        heatId: secondHeats[0].id,
        lane: secondHeats[0].lanes.indexOf("a1") + 1,
        timerId: "t1",
        timeMs: 25_800,
        recordedAt: 5,
        source: "stopwatch",
      },
    ],
  };

  const swims = athleteSwims("a1", [detail, faster]);
  eq(swims.length, 2, "both of Avery's swims");
  eq(swims[0].date, "2027-01-10", "newest first");
  eq(swims.map((s) => s.best), [true, false], "the faster one is the best");
  eq(swims[0].timeMs, 25_800, "and it's the one that actually was faster");
  eq(swims[0].place, 1, "with the place it earned in that event");

  // A time in another pool length is a different record entirely.
  const metric: MeetDetail = {
    ...faster,
    meet: { ...faster.meet, id: "m3", course: "LCM", date: "2027-02-01" },
  };
  const mixed = athleteSwims("a1", [detail, faster, metric]);
  eq(
    mixed.filter((s) => s.best).length,
    2,
    "a best per course, since a yard time and a metre time aren't comparable",
  );

  eq(athleteSwims("nobody", [detail]), [], "someone who never swam has no history");
}

done();

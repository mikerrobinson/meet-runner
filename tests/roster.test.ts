import { done, eq } from "./harness.ts";
import { createTeam, defaultSeasonName, parseTeamDoc } from "../app/lib/documents.ts";
import { currentSeason, dayBefore, enrollmentFor, isGraduating, makeSeason, nextSeasonName, nextYear, rosterFor, rosterForMeet, seasonForDate } from "../app/lib/roster.ts";

/* ------------------------------------------------ season */

/* ---- a team as the app writes it today ---- */
const legacy = parseTeamDoc({
  id: "t1", name: "Cactus Shadows", code: "CHAP", nameOrder: "first",
  currentSeasonId: "s1",
  seasons: [{ id: "s1", teamId: "t1", name: "2026-27" }],
  athletes: [
    { id: "a1", firstName: "Avery", lastName: "Nguyen", gender: "F", birthDate: "2009-03-14" },
    { id: "a2", firstName: "Marcus", lastName: "Hill", gender: "M" },
    { id: "a3", firstName: "Jo", lastName: "Park", gender: "F" },
  ],
  enrollments: [
    { id: "e1", teamId: "t1", seasonId: "s1", athleteId: "a1", year: "10", squad: "Blue", status: "active" },
    { id: "e2", teamId: "t1", seasonId: "s1", athleteId: "a2", year: "12", status: "active" },
    { id: "e3", teamId: "t1", seasonId: "s1", athleteId: "a3", year: "11", status: "inactive" },
  ],
  updatedAt: 1756000000000, syncedAt: 1756000000000,
})!;

eq(legacy.seasons.length, 1, "the season survives");
eq(legacy.currentSeasonId, "s1", "and is the current one");
eq(legacy.enrollments.length, 3, "enrollments survive");
const strayKeys = legacy.athletes.flatMap((s) =>
  ["year", "squad", "archived"].filter((k) => k in s),
);
eq(strayKeys, [], "athletes carry nothing seasonal");
eq(enrollmentFor(legacy, "a1", "s1")?.year, "10", "grade lives on the enrollment");
eq(enrollmentFor(legacy, "a1", "s1")?.squad, "Blue", "so does squad");
eq(enrollmentFor(legacy, "a3", "s1")?.status, "inactive", "and whether they're still on it");
eq(legacy.athletes.find((s) => s.id === "a1")?.birthDate, "2009-03-14", "birth dates survive");
eq(legacy.updatedAt, 1756000000000, "updatedAt untouched");
eq(rosterFor(legacy, "s1").map((s) => s.id), ["a1", "a2"], "the roster excludes the inactive swimmer");
eq(parseTeamDoc(JSON.parse(JSON.stringify(legacy))), legacy, "checking it twice changes nothing");

/* ---- an unbounded legacy season answers for every date ---- */
eq(seasonForDate(legacy, "2026-11-01")?.id, legacy.seasons[0].id, "a meet in season");
eq(seasonForDate(legacy, "1999-01-01")?.id, legacy.seasons[0].id, "and one long before it");
eq(rosterForMeet(legacy, { date: "2026-11-01" }).length, 2, "roster for a meet");

/* ---- two dated seasons ---- */
const team = createTeam("Chaparral");
const s26 = makeSeason(team.id, "2026-27", { startDate: "2026-08-01", endDate: "2027-07-31" });
const s27 = makeSeason(team.id, "2027-28", { startDate: "2027-08-01", endDate: "2028-07-31" });
const twoSeasons = { ...team, seasons: [s26, s27], currentSeasonId: s27.id };
eq(seasonForDate(twoSeasons, "2026-11-14")?.name, "2026-27", "November 2026 is last season");
eq(seasonForDate(twoSeasons, "2027-11-14")?.name, "2027-28", "November 2027 is this one");
eq(seasonForDate(twoSeasons, "2030-01-01")?.name, "2027-28", "a date outside every season falls back to current");
eq(currentSeason(twoSeasons)?.name, "2027-28", "current season");

/* ---- rolling a roster forward ---- */
eq(nextYear("10"), "11", "grades advance");
eq(nextYear("Fr"), "Fr", "shorthand is left alone");
eq(nextYear(""), "", "so is nothing");
eq(isGraduating("12"), true, "seniors are graduating");
eq(isGraduating("11"), false, "juniors aren't");
eq(isGraduating("Sr"), false, "shorthand never counts as graduating");
eq(nextSeasonName("2026-27"), "2027-28", "next season's name");
eq(nextSeasonName("2026-2027"), "2027-2028", "long form too");
eq(nextSeasonName("2026"), "2027", "a bare year just increments");
eq(nextSeasonName("Summer"), "", "and no guess when it isn't a school year");
eq(defaultSeasonName(new Date("2026-09-05")).length, 7, "a default name looks like a school year");
eq(defaultSeasonName(new Date("2026-09-05")), "2026-27", "autumn starts this year's season");
eq(defaultSeasonName(new Date("2027-02-05")), "2026-27", "February is still last autumn's season");

/* ---- closing one season when the next opens ---- */

eq(dayBefore("2027-08-01"), "2027-07-31", "the day before a month boundary");
eq(dayBefore("2027-01-01"), "2026-12-31", "and a year boundary");
eq(dayBefore("2028-03-01"), "2028-02-29", "leap year");

// The scenario that matters: a legacy unbounded season, then a new one opens.
// A meet already swum must keep drawing on the roster it was swum with.
const opened = "2027-08-01";
const rolled = {
  ...legacy,
  seasons: [
    { ...legacy.seasons[0], endDate: dayBefore(opened) },
    { id: "s2", teamId: "t1", name: "2027-28", startDate: opened },
  ],
  currentSeasonId: "s2",
  enrollments: [
    ...legacy.enrollments,
    { id: "e9", teamId: "t1", seasonId: "s2", athleteId: "a1", year: "11", status: "active" as const },
  ],
};
eq(seasonForDate(rolled, "2026-11-14")?.name, "2026-27", "a meet from last season stays in last season");
eq(seasonForDate(rolled, "2027-09-14")?.name, "2027-28", "and one from this season is in this one");
eq(rosterForMeet(rolled, { date: "2026-11-14" }).map((s) => s.id), ["a1", "a2"], "last season's meet keeps last season's roster");
eq(rosterForMeet(rolled, { date: "2027-09-14" }).map((s) => s.id), ["a1"], "this season's meet uses this season's");

done();

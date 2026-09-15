import { done, eq } from "./harness.ts";
import { exactTeam, rankTeams } from "../app/lib/team-search.ts";
import type { PublicTeam } from "../app/lib/public.ts";

const team = (id: string, name: string, code = ""): PublicTeam => ({
  id,
  name,
  code,
  claimed: true,
  athletes: 0,
  meets: 0,
  times: 0,
});

const teams = [
  team("t1", "Horizon", "HRZN"),
  team("t2", "Lake Horton", "LKH"),
  team("t3", "Cactus Shadows", "CACTUS"),
  team("t4", "horizon prep"),
];

const names = (list: PublicTeam[]) => list.map((t) => t.name);

/* --------------------------------------------- finding the one that exists */

// The whole point: three letters has to surface the school you mean. A name
// that *starts* with what was typed beats one that merely contains it,
// because on a phone the first two rows are the only ones anybody reads.
eq(
  names(rankTeams(teams, "hor")),
  ["Horizon", "horizon prep", "Lake Horton"],
  "a name starting with what was typed comes before one containing it",
);

// Case is not a distinction. "Horizon" and "horizon" being different teams is
// the exact failure the reference model exists to prevent.
eq(names(rankTeams(teams, "HORIZON")), ["Horizon", "horizon prep"], "matching ignores case");

// A code is an abbreviation somebody chose deliberately, so typing it exactly
// is the most specific thing you can do.
eq(names(rankTeams(teams, "lkh")), ["Lake Horton"], "an exact code finds its team");
eq(
  names(rankTeams(teams, "cactus"))[0],
  "Cactus Shadows",
  "an exact code wins even when it also matches a name",
);

// Opening the picker with no idea what the opponent is called should show the
// schools, not an empty box demanding a guess.
// Alphabetical the way somebody scanning a list means it, so a lower-case
// name files under its letter rather than after every capital.
eq(
  names(rankTeams(teams, "")),
  ["Cactus Shadows", "Horizon", "horizon prep", "Lake Horton"],
  "an empty query lists everyone alphabetically, ignoring case",
);

eq(names(rankTeams(teams, "zzz")), [], "no match offers nothing");

/* ------------------------------------------------- teams already on a meet */

// Listed directly above the box, so offering a row that does nothing when
// tapped is worse than not offering it.
eq(
  names(rankTeams(teams, "hor", ["t1"])),
  ["horizon prep", "Lake Horton"],
  "a team already racing is not offered again",
);
eq(names(rankTeams(teams, "", ["t1", "t2", "t3", "t4"])), [], "everyone racing leaves nothing to add");

/* ------------------------------------------------ what needs creating, and what doesn't */

eq(exactTeam(teams, "horizon")?.id, "t1", "an existing name is not a new team");
eq(exactTeam(teams, "HRZN")?.id, "t1", "nor is an existing code");
eq(exactTeam(teams, "  Horizon  ")?.id, "t1", "nor one somebody typed with spaces around it");
eq(exactTeam(teams, "Horizon Academy"), undefined, "a longer name genuinely is new");
eq(exactTeam(teams, ""), undefined, "an empty box is not a team");

// A team with no code must never be matched by another team's empty code —
// that would make every codeless team the same team.
eq(exactTeam([team("t5", "Newton")], ""), undefined, "an empty code matches nothing");

done();

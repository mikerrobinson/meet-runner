/**
 * Finding the school you're racing.
 *
 * Setting up a meet means naming an opponent, and the one thing that must not
 * happen is "Horizon", "horizon" and "Horzion" becoming three different teams
 * — which is the failure the whole reference model exists to prevent. So the
 * picker's job is to make the team that already exists easier to reach than
 * the one you'd create by accident: type three letters, see it, tap it.
 *
 * Pure and separate from the component so the ordering can be tested, because
 * the ordering is the part that decides whether somebody finds the existing
 * row or gives up and makes a second one.
 */

import type { PublicTeam } from "./public";

/**
 * How well a team answers what's been typed, lowest first.
 *
 * A code is an abbreviation somebody chose on purpose, so typing it exactly is
 * the most deliberate thing you can do and wins outright. After that, what a
 * name *starts* with beats what it merely contains: somebody typing "hor"
 * wants Horizon, not "Lake Horton" — and on a phone they will see the first
 * two rows and nothing else.
 */
function rank(team: PublicTeam, needle: string): number {
  const name = team.name.toLowerCase();
  const code = team.code.toLowerCase();

  if (code && code === needle) return 0;
  if (name === needle) return 1;
  if (name.startsWith(needle)) return 2;
  if (code.startsWith(needle)) return 3;
  if (name.includes(needle)) return 4;
  return 5;
}

/**
 * The teams worth offering for what's been typed, best first.
 *
 * Teams already racing are dropped rather than shown greyed out: they're
 * listed directly above this box, and offering a row that does nothing when
 * tapped is worse than not offering it.
 *
 * An empty query lists everything alphabetically. That's deliberate — opening
 * the picker with no idea what the opponent is called should show the roster
 * of schools, not an empty box demanding a guess.
 */
export function rankTeams(
  teams: PublicTeam[],
  query: string,
  exclude: string[] = [],
): PublicTeam[] {
  const taken = new Set(exclude);
  const needle = query.trim().toLowerCase();
  const available = teams.filter((team) => !taken.has(team.id));

  if (!needle) {
    return [...available].sort((a, b) => a.name.localeCompare(b.name));
  }

  return available
    .map((team) => ({ team, score: rank(team, needle) }))
    .filter((row) => row.score < 5)
    .sort(
      (a, b) => a.score - b.score || a.team.name.localeCompare(b.team.name),
    )
    .map((row) => row.team);
}

/**
 * The team this name already is, if it is one.
 *
 * Checked against every known team rather than the filtered list, including
 * ones already racing — otherwise adding "Horizon" twice would look like a
 * team that needs creating, and the button would offer to make a second one.
 * The server refuses that too and hands back the original, but a button that
 * lies about what it's going to do is a bug even when the server catches it.
 */
export function exactTeam(
  teams: PublicTeam[],
  query: string,
): PublicTeam | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  return teams.find(
    (team) =>
      team.name.toLowerCase() === needle ||
      (team.code !== "" && team.code.toLowerCase() === needle),
  );
}

/**
 * Reading a team: which season a date falls in, and who was on the roster.
 *
 * Pure lookups over the team document, kept out of the components so the rules
 * live in one place — "who can I enter in this meet?" is a question with one
 * answer, and it's here.
 */

import { generateId } from "./id";
import type {
  Enrollment,
  MeetDoc,
  Season,
  Swimmer,
  TeamDoc,
} from "~/types/meet";

/** Whether a season's dates contain a day. An open end is open forever. */
function covers(season: Season, isoDate: string): boolean {
  if (season.startDate && isoDate < season.startDate) return false;
  if (season.endDate && isoDate > season.endDate) return false;
  return true;
}

export function findSeason(
  team: TeamDoc,
  seasonId: string | undefined,
): Season | undefined {
  return team.seasons.find((s) => s.id === seasonId);
}

export function currentSeason(team: TeamDoc): Season | undefined {
  return findSeason(team, team.currentSeasonId) ?? team.seasons[0];
}

/**
 * The season a date belongs to.
 *
 * A team's seasons shouldn't overlap, so at most one contains any given day.
 * Where several could (an unbounded season carried over from before seasons
 * existed), the current one wins. A date outside every season — an August time
 * trial before the season officially opens, or a typo — falls back to the
 * current season rather than leaving the caller with no roster at all.
 */
export function seasonForDate(
  team: TeamDoc,
  isoDate: string,
): Season | undefined {
  const matches = team.seasons.filter((s) => covers(s, isoDate));
  if (matches.length === 0) return currentSeason(team);
  return (
    matches.find((s) => s.id === team.currentSeasonId) ??
    matches[matches.length - 1]
  );
}

/** The season a meet is swum in — derived from its date, never stored. */
export function seasonForMeet(
  team: TeamDoc,
  meet: Pick<MeetDoc, "date">,
): Season | undefined {
  return seasonForDate(team, meet.date);
}

export function enrollmentsIn(team: TeamDoc, seasonId: string): Enrollment[] {
  return team.enrollments.filter((e) => e.seasonId === seasonId);
}

/** Enrollments for a season keyed by athlete, for rows that need it per swimmer. */
export function enrollmentIndex(
  team: TeamDoc,
  seasonId: string | undefined,
): Map<string, Enrollment> {
  return new Map(
    team.enrollments
      .filter((e) => e.seasonId === seasonId)
      .map((e) => [e.athleteId, e] as const),
  );
}

export function enrollmentFor(
  team: TeamDoc,
  athleteId: string,
  seasonId: string | undefined,
): Enrollment | undefined {
  return team.enrollments.find(
    (e) => e.athleteId === athleteId && e.seasonId === seasonId,
  );
}

/**
 * Everyone who can be entered in a race this season, in document order.
 *
 * Callers sort — display order is a naming preference, not a roster fact.
 */
export function rosterFor(
  team: TeamDoc,
  seasonId: string | undefined,
): Swimmer[] {
  if (!seasonId) return [];
  const active = new Set(
    team.enrollments
      .filter((e) => e.seasonId === seasonId && e.status === "active")
      .map((e) => e.athleteId),
  );
  return team.swimmers.filter((s) => active.has(s.id));
}

/** Who's enterable in this meet: the roster of the season it falls in. */
export function rosterForMeet(
  team: TeamDoc,
  meet: Pick<MeetDoc, "date">,
): Swimmer[] {
  return rosterFor(team, seasonForMeet(team, meet)?.id);
}

/**
 * Everyone the team has ever had, whether or not they're on this season's
 * roster. Used where history matters — results, a swimmer's own page.
 */
export function findAthlete(
  team: TeamDoc,
  athleteId: string | undefined,
): Swimmer | undefined {
  return team.swimmers.find((s) => s.id === athleteId);
}

/** Seasons an athlete has an enrollment in, most recent first. */
export function seasonsFor(team: TeamDoc, athleteId: string): Season[] {
  const ids = new Set(
    team.enrollments
      .filter((e) => e.athleteId === athleteId)
      .map((e) => e.seasonId),
  );
  return team.seasons.filter((s) => ids.has(s.id)).reverse();
}

/** The ISO day before this one, for closing a season the day a new one opens. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function makeSeason(
  teamId: string,
  name: string,
  dates: { startDate?: string; endDate?: string } = {},
): Season {
  return {
    id: generateId(),
    teamId,
    name,
    startDate: dates.startDate || undefined,
    endDate: dates.endDate || undefined,
  };
}

export function makeEnrollment(
  teamId: string,
  seasonId: string,
  athleteId: string,
  facts: { year?: string; squad?: string; status?: Enrollment["status"] } = {},
): Enrollment {
  return {
    id: generateId(),
    teamId,
    seasonId,
    athleteId,
    year: facts.year ?? "",
    squad: facts.squad || undefined,
    status: facts.status ?? "active",
  };
}

/**
 * Grades advance on their own between seasons — "10" becomes "11". Anything
 * that isn't a plain number ("Fr", "Senior") is left as written, because
 * guessing at a coach's shorthand is worse than leaving it to them.
 */
export function nextYear(year: string): string {
  const value = Number(year.trim());
  return Number.isInteger(value) && value > 0 ? String(value + 1) : year;
}

/**
 * The label the next season would have. "2026-27" becomes "2027-28"; anything
 * that isn't in that shape is left to the coach to name.
 */
export function nextSeasonName(name: string): string {
  const trimmed = name.trim();

  // A bare year is a season name too — "2026" simply becomes "2027".
  if (/^\d{4}$/.test(trimmed)) return String(Number(trimmed) + 1);

  const match = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(trimmed);
  if (!match) return "";
  const start = Number(match[1]) + 1;
  const end =
    match[2].length === 2
      ? String((start + 1) % 100).padStart(2, "0")
      : String(start + 1);
  return `${start}-${end}`;
}

/** Whether a year reads as a final one — used to leave graduates behind. */
export function isGraduating(year: string, finalYear = 12): boolean {
  const value = Number(year.trim());
  return Number.isInteger(value) && value >= finalYear;
}

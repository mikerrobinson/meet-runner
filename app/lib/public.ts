/**
 * What anyone may see, and the shapes it comes in.
 *
 * High-school swim results are public: heat sheets are printed and handed out,
 * results are read over a PA, and a season's times end up on a school website.
 * So browsing meets, teams, rosters and results needs no account at all, and
 * the app stops pretending otherwise.
 *
 * Two things are *not* public, and both are guarded here rather than at the
 * edge of a component where a later refactor could quietly drop the check:
 *
 *   - **Birth dates.** Needed for age-group entries and SDIF export, and
 *     nobody else's business. A minor's date of birth is the one field on an
 *     athlete record worth real care.
 *   - **Contact details.** An email or mobile identifies an account, and
 *     never leaves the auth tables.
 *
 * Everything here is pure so the redaction can be tested without a database:
 * the question "can a birth date get out?" should have an answer that doesn't
 * depend on which route is asking.
 */

import { allResults } from "./timing";
import { eventName, isDiving } from "~/types/meet";
import type {
  Athlete,
  Gender,
  MeetCourse,
  MeetDoc,
  MeetType,
  Result,
  TeamDoc,
} from "~/types/meet";

/* ------------------------------------------------------------------ people */

/**
 * A person as the world may see them: a name and a gender, because both are
 * on every heat sheet ever printed. Deliberately built by naming the fields
 * that may travel rather than by deleting the ones that may not — a field
 * added to `Athlete` later is then private until someone decides otherwise.
 */
export interface PublicAthlete {
  id: string;
  firstName: string;
  lastName: string;
  gender: Gender;
}

export function publicAthlete(athlete: Athlete): PublicAthlete {
  return {
    id: athlete.id,
    firstName: athlete.firstName,
    lastName: athlete.lastName,
    gender: athlete.gender,
  };
}

export function publicAthletes(athletes: Athlete[]): PublicAthlete[] {
  return athletes.map(publicAthlete);
}

/* ------------------------------------------------------------------- teams */

export interface PublicTeam {
  id: string;
  name: string;
  code: string;
  /** Nobody has signed in as a coach of this team yet. */
  claimed: boolean;
  athletes: number;
  meets: number;
  /**
   * Recorded times across those meets. The surest sign of which season is the
   * real one when a device is deciding what to adopt — an empty roster pushed
   * by accident has none.
   */
  times: number;
}

/** A team named on a meet, for a heat sheet header. */
export interface TeamRef {
  id: string;
  name: string;
  code: string;
}

export function teamRef(team: TeamDoc): TeamRef {
  return { id: team.id, name: team.name, code: team.code };
}

/* ------------------------------------------------------------------- meets */

export interface PublicMeetSummary {
  id: string;
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teams: TeamRef[];
  hostTeamId?: string;
  /** Counts, so a list row can say how far along a meet is without loading it. */
  events: number;
  entries: number;
  times: number;
}

export function meetSummary(meet: MeetDoc, teams: TeamDoc[]): PublicMeetSummary {
  const named = meet.teamIds
    .map((id) => teams.find((team) => team.id === id))
    .filter((team): team is TeamDoc => team !== undefined)
    .map(teamRef);

  const lanes = new Set<string>();
  for (const watch of meet.watches) lanes.add(`${watch.heatId}:${watch.lane}`);
  for (const ruling of meet.rulings) lanes.add(`${ruling.heatId}:${ruling.lane}`);

  return {
    id: meet.id,
    name: meet.name,
    date: meet.date,
    type: meet.type,
    course: meet.course,
    location: meet.location,
    teams: named,
    hostTeamId: meet.hostTeamId,
    events: meet.events.length,
    entries: Object.values(meet.entries).reduce(
      (total, list) => total + list.length,
      0,
    ),
    times: lanes.size,
  };
}

/** One swim, as it would be read out: a place, a name, a time. */
export interface PublicPlacing {
  place: number | null;
  athlete: PublicAthlete | null;
  /** The team they were racing for, worked out from their enrollment. */
  team: TeamRef | null;
  lane: number;
  heat: number;
  timeMs: number;
  status: Result["status"];
  /** How the official time was arrived at — "median of three", and so on. */
  method: Result["method"];
  watchCount: number;
  /** Nobody was seeded here; a timer said who it was. */
  attributed: boolean;
}

export interface PublicEventResults {
  id: string;
  name: string;
  distance: number;
  stroke: string;
  gender: string;
  /** Absent for diving, which holds its place in the order but isn't timed. */
  placings: PublicPlacing[];
}

export interface PublicMeetDetail extends PublicMeetSummary {
  results: PublicEventResults[];
}

/**
 * A meet's results, event by event, ranked across all of its heats.
 *
 * Ranking ignores heat: a slower heat can hold the fastest swim, and the
 * printed sheet has always been ordered by time rather than by when it was
 * swum. DQs and no-shows keep their line and lose their place, because
 * "who was disqualified" is part of the record.
 */
export function meetResults(
  meet: MeetDoc,
  athletes: Athlete[],
  teamOf: (athleteId: string) => TeamRef | null,
): PublicEventResults[] {
  const byId = new Map(athletes.map((a) => [a.id, a] as const));
  const heatNumber = new Map(meet.heats.map((h) => [h.id, h.index + 1] as const));
  const results = allResults(meet);

  return meet.events.map((event) => {
    const forEvent = results
      .filter((result) => result.eventId === event.id)
      .sort((a, b) => {
        // Anything without a clean time sorts last, whatever the clock said.
        if (a.status !== b.status) {
          if (a.status === "OK") return -1;
          if (b.status === "OK") return 1;
        }
        return a.timeMs - b.timeMs;
      });

    let place = 0;
    const placings: PublicPlacing[] = forEvent.map((result) => {
      const athlete = byId.get(result.athleteId);
      return {
        place: result.status === "OK" ? ++place : null,
        athlete: athlete ? publicAthlete(athlete) : null,
        team: teamOf(result.athleteId),
        lane: result.lane,
        heat: heatNumber.get(result.heatId) ?? 1,
        timeMs: result.timeMs,
        status: result.status,
        method: result.method,
        watchCount: result.watchCount,
        attributed: result.attributed === true,
      };
    });

    return {
      id: event.id,
      name: eventName(event),
      distance: event.distance,
      stroke: event.stroke,
      gender: event.gender,
      placings: isDiving(event) ? [] : placings,
    };
  });
}

/* ---------------------------------------------------------------- athletes */

/** One swim on an athlete's own page. */
export interface AthleteSwim {
  meetId: string;
  meetName: string;
  date: string;
  course: MeetCourse;
  eventName: string;
  /** Groups a swimmer's times for the same race across a season. */
  raceKey: string;
  timeMs: number;
  status: Result["status"];
  /** True for the fastest clean swim of this race in this course. */
  best: boolean;
}

export interface PublicAthleteDetail extends PublicAthlete {
  teams: Array<TeamRef & { seasons: string[] }>;
  swims: AthleteSwim[];
}

/**
 * Everything one person has swum, newest first, with their best marked.
 *
 * "Best" is per race *and* course: a 100 Free in a 25-yard pool and one in a
 * 50-metre pool are not the same swim, and calling either a personal best over
 * the other would be wrong in a way a swimmer would notice immediately.
 */
export function athleteSwims(
  athleteId: string,
  meets: MeetDoc[],
): AthleteSwim[] {
  const swims: AthleteSwim[] = [];

  for (const meet of meets) {
    const events = new Map(meet.events.map((e) => [e.id, e] as const));
    for (const result of allResults(meet)) {
      if (result.athleteId !== athleteId) continue;
      const event = events.get(result.eventId);
      if (!event || isDiving(event)) continue;
      swims.push({
        meetId: meet.id,
        meetName: meet.name,
        date: meet.date,
        course: meet.course,
        eventName: eventName(event),
        raceKey: `${event.distance}|${event.stroke}|${meet.course}`,
        timeMs: result.timeMs,
        status: result.status,
        best: false,
      });
    }
  }

  const fastest = new Map<string, number>();
  for (const swim of swims) {
    if (swim.status !== "OK") continue;
    const current = fastest.get(swim.raceKey);
    if (current === undefined || swim.timeMs < current) {
      fastest.set(swim.raceKey, swim.timeMs);
    }
  }
  for (const swim of swims) {
    swim.best = swim.status === "OK" && fastest.get(swim.raceKey) === swim.timeMs;
  }

  return swims.sort(
    (a, b) => b.date.localeCompare(a.date) || a.eventName.localeCompare(b.eventName),
  );
}

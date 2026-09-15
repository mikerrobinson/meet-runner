/**
 * What somebody may do, as pure predicates.
 *
 * Split from `access.server.ts` because both sides need these: the loader
 * asks them to decide what to allow, and the screen asks the same functions to
 * decide what to draw. One definition, so the button and the endpoint can't
 * disagree about who may press it.
 *
 * The answers come from a `MeetAccess`, which only the server can work out —
 * see `meetAccess`.
 */

export interface MeetAccess {
  signedIn: boolean;
  userId: string | null;
  /** Runs the meet: the lineup, the seeding, the calls, the sign-offs. */
  admin: boolean;
  /** Teams racing this meet that this person coaches. */
  coachOf: string[];
  /** The roster entry this account is, if a coach has linked one. */
  athleteId: string | null;
}

/** Nobody in particular — a parent following a link to the results. */
export const ANONYMOUS: MeetAccess = {
  signedIn: false,
  userId: null,
  admin: false,
  coachOf: [],
  athleteId: null,
};

export interface TeamAccess {
  signedIn: boolean;
  userId: string | null;
  /** Coaches this team, so may change its roster and seasons. The only
   *  standing there is: you are in `team_coaches` or you are a visitor. */
  coach: boolean;
}


/**
 * The meet's own details, its lineup and its seeding.
 *
 * Running a meet is scoped to the meet rather than to a team, because a meet
 * belongs to no team — often it's the host's coach, sometimes a referee who
 * coaches nobody.
 */
export function mayEditMeet(access: MeetAccess): boolean {
  return access.admin;
}

/**
 * Deciding a lane: a DQ, a time entered by hand, a sign-off.
 *
 * Administrators only. With two schools in the water it isn't one school's
 * call to make.
 */
export function mayDecide(access: MeetAccess): boolean {
  return access.admin;
}

/**
 * Recording a time.
 *
 * Deliberately wider than deciding one. A watch is evidence, there is one row
 * per timer, and an extra one never overwrites anybody — so every coach keeps
 * their stopwatch.
 */
export function mayRecordTime(access: MeetAccess): boolean {
  return access.admin || access.coachOf.length > 0;
}

/**
 * Entering or scratching one swimmer.
 *
 * A coach may do it for their own team's swimmers. A linked swimmer may do it
 * for themselves, if the meet says so — off by default, because most coaches
 * pick the lineup and the ones who hand it over want to say so deliberately.
 */
export function mayEnter(
  access: MeetAccess,
  athleteId: string,
  options: { athletesMayEnter: boolean; teamsOf: (id: string) => string[] },
): boolean {
  if (access.admin) return true;
  if (options.teamsOf(athleteId).some((t) => access.coachOf.includes(t))) {
    return true;
  }
  return options.athletesMayEnter && access.athleteId === athleteId;
}

/** Anything at all beyond looking. Drives whether editing chrome renders. */
export function mayEditAnything(access: MeetAccess): boolean {
  return access.admin || access.coachOf.length > 0 || access.athleteId !== null;
}

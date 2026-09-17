/**
 * The data model, as plain objects.
 *
 * Three things, and only one of them owns anything. **Athletes** are people,
 * global and durable — a swimmer is one record whether they swim for a school,
 * a club, or both. A **team** owns its seasons and says, through enrollments,
 * who swam for it and when. A **meet** is one day's racing between one or more
 * teams, and belongs to none of them.
 *
 * That last point is the load-bearing one. A meet referencing teams rather than
 * being owned by one is what lets a dual meet be a single shared thing instead
 * of two half-copies, and what keeps a visiting swimmer from being retyped into
 * the home team's roster.
 *
 * Everything here is a POCO: one interface per table row, no version numbers,
 * no `updatedAt` for merging, no `deletedAt` tombstones. The server is the
 * source of truth, rows are written by the people who own them, and a delete
 * is a DELETE.
 */

export type Gender = "M" | "F";

/** Events can be restricted to one gender, or open to everyone. */
export type EventGender = Gender | "Open";

export type Stroke =
  | "Free"
  | "Back"
  | "Breast"
  | "Fly"
  | "IM"
  | "Free Relay"
  | "Medley Relay"
  | "Diving";

/**
 * Strokes offered when adding an event by hand. Diving is deliberately absent:
 * it's added and removed by the meet's "include diving" option, not picked with
 * a distance like a swim.
 */
export const STROKES: Stroke[] = [
  "Free",
  "Back",
  "Breast",
  "Fly",
  "IM",
  "Free Relay",
  "Medley Relay",
];

/**
 * Diving sits in the event list purely so divers can see it on the
 * registration grid alongside their swims — plenty of divers swim too. It
 * isn't timed, scored, or run here; the app is not a diving tool.
 */
export function isDiving(event: Pick<MeetEvent, "stroke">): boolean {
  return event.stroke === "Diving";
}

/** Placeholder distance for diving, which has none. Never displayed. */
export const DIVING_DISTANCE = 1;

/**
 * Relays are timed exactly like any other event: one lane, one clock, one
 * time. The app doesn't model the four legs — a relay lane is held by a single
 * athlete standing in for the squad, usually whoever leads off.
 */
export function isRelay(event: Pick<MeetEvent, "stroke">): boolean {
  return event.stroke.endsWith("Relay");
}

/** Squeezed for the registration grid, where a column is about 3.5rem wide. */
export function shortStroke(stroke: Stroke): string {
  if (stroke === "Free Relay") return "Free R";
  if (stroke === "Medley Relay") return "Mdly R";
  return stroke;
}

export type LaneCount = 4 | 5 | 6 | 8 | 10;

/**
 * Offered widths, likeliest first: six lanes is the high-school norm, and a
 * five- or four-lane pool is a real thing at a small school.
 */
export const LANE_COUNTS: LaneCount[] = [6, 8, 10, 5, 4];

export function isLaneCount(value: unknown): value is LaneCount {
  return LANE_COUNTS.includes(value as LaneCount);
}

/**
 * How many stopwatches a lane is timed by.
 *
 * A deck fact rather than a preference: a lane has one, two or three people
 * standing behind it with watches, and everything about how times reach the
 * app follows from which. One is a phone per timer, self-reporting. Two or
 * three is the arrangement this was built for — the timers hold handheld
 * watches and read them out to whoever is holding the clipboard, who is the
 * only one with a phone.
 *
 * Three is the ceiling because three is what the hand-timing rules are for:
 * the third watch is the one that outvotes a slow thumb, and a fourth adds
 * nothing the median didn't already have.
 */
export type TimersPerLane = 1 | 2 | 3;

export const TIMERS_PER_LANE: TimersPerLane[] = [1, 2, 3];

export function isTimersPerLane(value: unknown): value is TimersPerLane {
  return TIMERS_PER_LANE.includes(value as TimersPerLane);
}

/**
 * How the lane buttons are arranged while running a heat. The two list
 * layouts put the lanes in a single column in pool order, so whoever is
 * watching from the side maps a finish straight onto a button without having
 * to work out which column it's in.
 *
 * A device preference rather than a meet option — it depends on where the
 * person holding the phone is standing, not on the meet — so it lives in
 * `storage.ts` and is never written to the server.
 */
export type LaneLayout = "grid" | "list-asc" | "list-desc";

export const LANE_LAYOUTS: LaneLayout[] = ["grid", "list-asc", "list-desc"];

/** Lane numbers in the order they should be drawn for a layout. */
export function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
}

/**
 * Where a device has got to in the running order.
 *
 * Device state, kept in `storage.ts` alongside the lane layout. Three people
 * work one meet from three different places in the programme — an
 * administrator signing off event 4 while the deck swims 6 — so there is no
 * single answer to store.
 */
export interface Progress {
  eventIndex: number;
  heatIndex: number;
}

/* ------------------------------------------------------------ people, teams */

/**
 * A person, and only the things that stay true about them wherever they swim.
 *
 * Global: an athlete belongs to no team. Who they swim for, and when, is said
 * by an `Enrollment` — which is what lets one person swim for a school in
 * winter and a club in summer without becoming two people, and what stops a
 * visiting swimmer being copied into the roster of every team that races them.
 *
 * Durable and never deleted, since results reference athletes by id forever.
 */
export interface Athlete {
  id: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  /**
   * ISO date (yyyy-mm-dd). Optional: a high-school dual meet never asks, but
   * age-group entries do, and the SDIF (.sd3) files other systems exchange
   * carry it on every athlete record.
   *
   * Private. It never leaves the server except to this person or their coach.
   */
  birthDate?: string;
  /**
   * The account this athlete is, when they have one. Absent for everyone who
   * has never signed in, which is most of a roster.
   */
  userId?: string;
}

/**
 * A team: a name, a code, and the seasons it runs.
 *
 * Deliberately does *not* hold its athletes. The roster is the set of
 * enrollments pointing at global athlete records, so two teams racing the same
 * swimmer point at one person rather than keeping a copy each.
 *
 * A team can exist without anyone owning it. Setting up a meet against a school
 * that has never used the app mints an unclaimed team; a coach from that school
 * claims it later, and the meets it already appears in are unaffected.
 */
export interface Team {
  id: string;
  name: string;
  /** Short code as it appears on a heat sheet or an SD3 file — "CHAP". */
  code: string;
  /** Which season the app works in when nothing says otherwise. */
  currentSeasonId?: string;
  /** Who set it up. Absent for the teams typed in as opponents before this
   *  was recorded, and for the ones that predate accounts entirely. */
  createdBy?: string;
}

/**
 * A team's competitive year. Scoped to the team on purpose: a high-school
 * season and a club season don't line up, so there's no useful global one.
 *
 * Both dates are optional — a season with neither runs from the beginning of
 * time to the end of it.
 */
export interface Season {
  id: string;
  teamId: string;
  /** Free text as the coach writes it — "2026-27", "Summer 2027". */
  name: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  startDate?: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  endDate?: string;
}

/**
 * On the roster, but only for a while.
 *
 * Everything seasonal about an athlete lives here rather than on the athlete,
 * so last year's sophomore is this year's junior without anyone editing
 * anything, and an athlete who moves between a club and a school team is one
 * person with two enrollments.
 */
export interface Enrollment {
  id: string;
  teamId: string;
  seasonId: string;
  athleteId: string;
  /** School year as entered — "9", "Fr", "Senior", whatever the CSV had. */
  year: string;
  /** Optional squad/side for an inter-squad meet (e.g. "Blue" / "Gold"). */
  squad?: string;
  /**
   * "inactive" is someone who left mid-season: off the roster for new races,
   * but they were on it, and any times they swam still stand. Someone who
   * simply isn't on the team this year has no enrollment at all.
   */
  status: EnrollmentStatus;
}

export type EnrollmentStatus = "active" | "inactive";

/**
 * How names are ordered and written. "last" gives "Aaronson, Avery" sorted by
 * surname; "first" gives "Avery Aaronson" sorted by given name. A preference
 * of whoever is looking, so it lives on the device.
 */
export type NameOrder = "first" | "last";

/** Team codes are short and upper-case wherever they're exchanged. */
export function normalizeTeamCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/**
 * Age on a given date — what age-group entries are seeded by, and what an
 * export has to state. Returns null when the birth date is missing or
 * unparseable rather than guessing at one.
 */
export function ageOn(
  athlete: Pick<Athlete, "birthDate">,
  isoDate: string,
): number | null {
  const born = parseIsoDate(athlete.birthDate);
  const on = parseIsoDate(isoDate);
  if (!born || !on) return null;

  let age = on.year - born.year;
  // Not yet had this year's birthday.
  if (on.month < born.month || (on.month === born.month && on.day < born.day)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function parseIsoDate(
  value: string | undefined,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** Today, as the plain ISO day the rest of the model speaks in. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------- meet */

export type MeetType =
  | "intersquad"
  | "dual"
  | "tri"
  | "invitational"
  | "time-trial";

export const MEET_TYPES: Array<{ value: MeetType; label: string }> = [
  { value: "intersquad", label: "Inter-squad" },
  { value: "dual", label: "Dual" },
  { value: "tri", label: "Tri" },
  { value: "invitational", label: "Invitational" },
  { value: "time-trial", label: "Time trial" },
];

export function meetTypeLabel(type: MeetType): string {
  return MEET_TYPES.find((t) => t.value === type)?.label ?? "Meet";
}

/**
 * The pool a meet is swum in. Short course yards is the US high-school
 * default; the metric courses cover summer league and club water. Recorded
 * with the meet because a time only means something next to its course.
 */
export type MeetCourse = "SCY" | "LCM" | "SCM";

export const MEET_COURSES: Array<{
  value: MeetCourse;
  label: string;
  detail: string;
}> = [
  { value: "SCY", label: "SCY", detail: "25 yard" },
  { value: "LCM", label: "LCM", detail: "50 metre" },
  { value: "SCM", label: "SCM", detail: "25 metre" },
];

export function isMeetCourse(value: unknown): value is MeetCourse {
  return MEET_COURSES.some((c) => c.value === value);
}

/** Long form for the dropdown, e.g. "SCY — 25 yard". */
export function courseLabel(course: MeetCourse): string {
  const match = MEET_COURSES.find((c) => c.value === course);
  return match ? `${match.label} — ${match.detail}` : course;
}

/**
 * How many races one swimmer may be in.
 *
 * NFHS caps a high-school swimmer at four events, at most two of them
 * individual, and states vary — so these are numbers on the meet rather than
 * constants. Absent means no limit, which is what an inter-squad time trial
 * wants.
 */
export interface EntryLimits {
  maxIndividual?: number;
  maxRelays?: number;
  maxTotal?: number;
  /** How many entries one team may put in a single race. */
  maxPerTeamPerEvent?: number;
}

/**
 * Who may see a meet's entries before it's swum.
 *
 * A lineup is competitive information: at a dual meet, knowing who the other
 * school is putting in the 200 Free is worth something. Results are unaffected
 * either way — those are public once they exist.
 */
export type EntryVisibility = "everyone" | "own-team";

/**
 * Which lanes a team swims, by team id.
 *
 * A team missing from the map hasn't been assigned lanes yet. Nothing here
 * enforces that two teams' lanes don't overlap — this is what the coach typed,
 * not a validated seat chart.
 */
export type LaneAssignments = Record<string, number[]>;

/**
 * "1, 3, 5" -> [1, 3, 5]. Blank and non-numeric entries are dropped, order
 * kept — what a lane list or a points list is typed as and stored as.
 */
export function parseNumberList(text: string): number[] {
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** The reverse of `parseNumberList`, for filling a text box back in. */
export function formatNumberList(values: number[]): string {
  return values.join(", ");
}

/**
 * One day's racing.
 *
 * The lineup, entries, heats and times are their own rows in their own tables,
 * fetched when a screen needs them. A meet row is just the meet.
 */
export interface Meet {
  id: string;
  name: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  type: MeetType;
  course: MeetCourse;
  /** Where it's being swum, free text — e.g. "Cactus Aquatic Center". */
  location?: string;
  /** The teams racing, by reference. A meet belongs to none of them. */
  teamIds: string[];
  /** Whose pool it is, when that matters. Always one of `teamIds`. */
  hostTeamId?: string;
  /** The account that set it up. */
  createdBy?: string;
  laneCount: LaneCount;
  /**
   * How many watches a lane is expected to be timed by.
   *
   * One — the default, and what every meet before this setting existed was —
   * means a timing phone is one person's stopwatch. More means a lane has
   * that many handheld watches on it, and a phone standing behind that lane
   * may be the clipboard recording all of them. Which of the two a given
   * phone is doing is that phone's own answer, not the meet's: see
   * `timer-lanes.tsx`.
   */
  timersPerLane: TimersPerLane;
  /** Which gender swims first in each pair of a split lineup. */
  leadGender: Gender;
  /** Whether the lineup carries a Diving event. */
  includeDiving: boolean;
  limits: EntryLimits;
  entryVisibility: EntryVisibility;
  /**
   * Whether a swimmer whose account is linked may enter and scratch
   * themselves. Off by default: most coaches pick the lineup.
   */
  athletesMayEnter: boolean;
  /**
   * Which lanes each team swims. Usually one team gets the odds and the other
   * the evens in a dual meet, but that's an assumption a triangular meet or an
   * odd-width pool breaks — so it's said explicitly rather than derived.
   */
  laneAssignments: LaneAssignments;
  /** How this meet's races turn into points. See `ScoringRules`. */
  scoring: ScoringRules;
}

/** One race in a meet's programme. `position` is the order it's swum in. */
export interface MeetEvent {
  id: string;
  meetId: string;
  position: number;
  distance: number;
  stroke: Stroke;
  gender: EventGender;
  /** Optional label override; otherwise derived from distance/stroke/gender. */
  name?: string;
}

/** One swimmer registered in one race. */
export interface Entry {
  meetId: string;
  eventId: string;
  athleteId: string;
}

/**
 * One planned swim: somebody, in a lane, in a heat of an event.
 *
 * The unit everything about running a meet hangs off. Seeding an event makes
 * one of these per entered swimmer; a timer naming the person behind the
 * blocks makes one too, because a lane nobody expected is still a swim. Times
 * belong to it and the official result is about it.
 *
 * There is no `heats` table. A heat is which heat — a small integer, 1-based,
 * and usually 1 — so "the heats of this event" is the distinct heats across
 * its seeds, and a heat cannot exist with nothing in it. A row with an id of
 * its own is what lets a time survive somebody being moved between lanes.
 */
export interface Seed {
  id: string;
  meetId: string;
  eventId: string;
  /** Which heat of the event, 1-based. Usually 1. */
  heat: number;
  /** Which lane, 1-based. */
  lane: number;
  /**
   * Who is in it — or `""`, meaning nobody has said yet.
   *
   * An empty lane and an unnamed one are different things: the first has no
   * row at all, the second has a swim somebody timed before the name was
   * settled. Only a time arriving for a lane nobody has named creates one,
   * and it stops being empty the moment anybody says who was there.
   */
  athleteId: string;
  /** What they are expected to swim, when anybody knows. Nothing reads it yet. */
  seedTimeMs?: number;
}

export type ResultStatus = "OK" | "DQ" | "NS";

/**
 * One person's watch on one lane.
 *
 * A lane is timed by whoever is standing at it — often two or three people,
 * plus a coach — so a race produces several times for the same swim and the
 * official one is worked out from them. Each watch is its own row: nobody
 * overwrites anybody, a timer can correct their own time and only their own,
 * and two timers on different lanes never touch the same thing.
 *
 * Keyed by heat, lane and timer, so sending the same watch twice — a retry
 * after the wifi drops at the wall — is an update rather than a duplicate.
 */
export type WatchRole = "timer" | "coach" | "admin";

export interface Watch {
  /** The swim it measures. */
  seedId: string;
  /**
   * Whoever took it, and the key one watch per swim is filed under.
   *
   * A device id for a volunteer behind a lane, who has no account and is
   * identified only by the phone they scanned with. A *user* id for anybody
   * signed in — a coach on the multi-lane stopwatch, an administrator typing
   * a time at the desk — so that person keeps one watch per swim whichever
   * device they happen to pick up.
   */
  timerId: string;
  /**
   * The account behind it, when there was one. Absent for a QR-code timer.
   * The server sets it from the session rather than believing the client.
   */
  userId?: string;
  /**
   * What the submitter was to this meet when they took it.
   *
   * Recorded rather than looked up later: a coach made an administrator in
   * March must not retroactively turn the watch they held in January into the
   * official's own reading.
   */
  role: WatchRole;
  /**
   * The time, once there is one.
   *
   * Absent means a stopwatch is running and nothing has been submitted yet —
   * which is how the desk tells a lane nobody is covering from one whose
   * timers are still holding their clocks. There is no separate table of
   * armed stopwatches, because a watch with a start and no time says it.
   *
   * Nothing that works out a swim's time may see one of these; they are
   * filtered out in `timedWatches`, which every such reader goes through.
   */
  timeMs?: number;
  recordedAt: number;
  /**
   * When the watch was started and stopped, on the server's clock.
   *
   * Both present means a stopwatch in this app ran the race; neither means the
   * time was typed in. There is no "source" field saying which, because it
   * could only repeat what these two already say.
   *
   * Translated from the phone's own clock on the way in, because the desk
   * draws a running stopwatch from `startedAt` and that means comparing it
   * against the desk's now.
   */
  startedAt?: number;
  stoppedAt?: number;
}

/**
 * The official outcome of one swim, and the only thing here an administrator
 * writes.
 *
 * It exists because somebody signed the lane off. That is the whole of its
 * meaning: no `final` flag, because a row that is not signed off is a row that
 * is not there, and no snapshot of what the watches said, because the number
 * that was accepted is written straight in. A late watch cannot move it, a
 * discarded watch cannot move it, and taking it back is deleting it.
 *
 * `athleteId` and `eventId` are copied from the seed so results can be listed,
 * ranked and exported without reassembling the meet — the same reason `meetId`
 * is denormalised everywhere else.
 */
export interface Result {
  seedId: string;
  meetId: string;
  eventId: string;
  athleteId: string;
  status: ResultStatus;
  /** Zero for a no-show or a disqualification with nothing on the clock. */
  timeMs: number;
  decidedBy?: string;
  decidedAt: number;
}

/** How a proposed time was arrived at, for anyone asking why it says that. */
export type TimeMethod = "single" | "average" | "median" | "official";

export interface MeetDetail {
  meet: Meet;
  teams: Team[];
  events: MeetEvent[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  /** Every planned swim: who is in which lane of which heat. */
  seeds: Seed[];
  /** Every measurement, including stopwatches that are still running. */
  watches: Watch[];
  /** Every swim an administrator has signed off. */
  results: Result[];
  /** Everyone these rows refer to, so no screen has to fetch people itself. */
  athletes: Athlete[];
  /**
   * The racing teams' rosters for this meet's season.
   *
   * What the registration grid draws its rows from, and where a swimmer's
   * year and squad come from — as of this meet, not as of today.
   */
  enrollments: Enrollment[];
}

/** How places turn into points. Nothing computes these yet. */
export interface ScoringRules {
  /** Points by place, best first: [6, 4, 3, 2, 1] for a dual meet. */
  individual: number[];
  /** Relays usually score differently, and fewer of them place: [8, 4]. */
  relay: number[];
  /** Dual meets score the girls' and boys' halves as separate contests. */
  separateByGender: boolean;
}

/** 6-4-3-2-1 individual, 8-4 relay, girls and boys scored apart. */
export const DUAL_MEET_SCORING: ScoringRules = {
  individual: [6, 4, 3, 2, 1],
  relay: [8, 4],
  separateByGender: true,
};

/* ------------------------------------------------------------------ naming */

export function athleteName(s: Athlete): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

/**
 * Roster order. Whichever name isn't being sorted on breaks the tie, so
 * siblings — same surname, different given name — always land in the same
 * order rather than shuffling between renders.
 */
export function byAthlete(order: NameOrder = "last") {
  return (a: Athlete, b: Athlete): number =>
    order === "first"
      ? a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName)
      : a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName);
}

/**
 * A name written the way the list is sorted, so the part you're scanning comes
 * first: "Aaronson, Avery" under a surname sort, "Avery Aaronson" under a
 * given-name one. Always both names in full — no initials.
 */
export function displayName(s: Athlete, order: NameOrder = "last"): string {
  if (order === "first") return `${s.firstName} ${s.lastName}`.trim();
  const first = s.firstName.trim();
  return first ? `${s.lastName}, ${first}` : s.lastName;
}

export function eventName(e: Pick<MeetEvent, "name" | "gender" | "stroke" | "distance">): string {
  if (e.name) return e.name;
  const prefix = e.gender === "Open" ? "" : e.gender === "M" ? "Boys " : "Girls ";
  // Diving carries a placeholder distance, so don't write it out.
  if (isDiving(e)) return `${prefix}Diving`;
  return `${prefix}${e.distance} ${e.stroke}`;
}

/** "Dual vs Central" / "Inter-squad" — the subtitle in the meet list. */
export function meetSubtitle(meet: Pick<Meet, "type">): string {
  return meetTypeLabel(meet.type);
}

/**
 * Girls' and boys' versions of the same race share a key. Registration shows
 * one column per race and picks the right event from the swimmer's gender, so
 * a split lineup doesn't double the width of the grid.
 */
export function raceKey(event: Pick<MeetEvent, "distance" | "stroke">): string {
  return `${event.distance}|${event.stroke}`;
}

/** Whether an athlete is eligible for an event, given its gender restriction. */
export function isEligible(athlete: Athlete, event: Pick<MeetEvent, "gender">): boolean {
  return event.gender === "Open" || event.gender === athlete.gender;
}

/**
 * Someone by id, from anywhere in the team's history.
 *
 * Results from past meets point at people who may have left the roster since,
 * so this looks through everyone rather than just this season's.
 */
export function findAthlete(
  athletes: Athlete[],
  id: string | null | undefined,
): Athlete | undefined {
  if (!id) return undefined;
  return athletes.find((a) => a.id === id);
}

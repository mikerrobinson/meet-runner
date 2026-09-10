/**
 * Core data model.
 *
 * Three things, and only one of them owns anything. **Athletes** are people,
 * global and durable — a swimmer is one record whether they swim for a school,
 * a club, or both. A **team** owns its seasons and states, through enrollments,
 * who swam for it and when. A **meet** is one day's racing between two or more
 * teams, and belongs to none of them.
 *
 * That last point is the load-bearing one. A meet referencing teams rather than
 * being owned by one is what lets a dual meet be a single shared thing instead
 * of two half-copies, and what keeps a visiting swimmer from being retyped into
 * the home team's roster.
 *
 * Everything here is plain JSON — no Map, Set, or Date — so the same value
 * round-trips through IndexedDB and the server unchanged.
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
 * How the lane buttons are arranged while running a heat. The two list
 * layouts put the lanes in a single column in pool order, so whoever is
 * watching from the side maps a finish straight onto a button without
 * having to work out which column it's in.
 *
 * A device preference rather than a meet option — it depends on where the
 * person holding the phone is standing, not on the meet — so it lives in
 * `storage.ts` and never syncs.
 */
export type LaneLayout = "grid" | "list-asc" | "list-desc";

export const LANE_LAYOUTS: LaneLayout[] = ["grid", "list-asc", "list-desc"];

/** Lane numbers in the order they should be drawn for a layout. */
export function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
}

/* -------------------------------------------------------------------- team */

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
   * The account this athlete is, when they have one.
   *
   * How a swimmer signing in becomes a swimmer rather than a spectator: it's
   * the link that lets them see their own entries and change them. Absent for
   * everyone who has never signed in, which is most of a roster.
   */
  userId?: string;
}

/**
 * A team's competitive year. Scoped to the team on purpose: a high-school
 * season and a club season don't line up, so there's no useful global one.
 *
 * The dates are what a meet's season is derived from, and both are optional —
 * a season with neither runs from the beginning of time to the end of it,
 * which is exactly what a roster carried over from before seasons existed
 * means.
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
 * On the roster, but only for a while. Everything seasonal about a athlete
 * lives here rather than on the athlete, so last year's sophomore is this
 * year's junior without anyone editing anything, and a athlete who moves
 * between a club and a school team is one person with two enrollments.
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
 * surname; "first" gives "Avery Aaronson" sorted by given name. A coach's
 * preference rather than a device's, so it lives on the team and follows them
 * between devices.
 */
export type NameOrder = "first" | "last";

/**
 * A team: its seasons, and who swam for it in each of them.
 *
 * Deliberately does *not* hold its athletes. The roster is the set of
 * enrollments pointing at global athlete records, so two teams racing the same
 * swimmer point at one person rather than keeping a copy each.
 *
 * A team can exist without anyone owning it. Setting up a meet against a school
 * that has never used the app mints an unclaimed team; a coach from that school
 * claims it later, and the meets it already appears in are unaffected.
 */
export interface TeamDoc {
  version: number;
  id: string;
  name: string;
  /** Short code as it appears on a heat sheet or an SD3 file — "CHAP". */
  code: string;
  /** Which season the app is working in when nothing says otherwise. */
  currentSeasonId: string;
  seasons: Season[];
  enrollments: Enrollment[];
  updatedAt: number;
}

export const TEAM_DOC_VERSION = 6;

/** Team codes are short and upper-case wherever they're exchanged. */
export function normalizeTeamCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/**
 * Age on a given date — what entries are actually seeded by, and what an
 * export has to state. Returns null when the birth date is missing or
 * unparseable rather than guessing at one.
 *
 * Both dates are plain ISO days, so this compares calendar parts and never
 * touches a timezone.
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

export type MeetType = "intersquad" | "dual" | "tri" | "invitational" | "time-trial";

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

export interface MeetEvent {
  id: string;
  distance: number;
  stroke: Stroke;
  gender: EventGender;
  /** Optional label override; otherwise derived from distance/stroke/gender. */
  name?: string;
}

/** eventId -> athleteIds registered in that event. */
export type Entries = Record<string, string[]>;

export interface Heat {
  id: string;
  eventId: string;
  /** 0-based position within the event. */
  index: number;
  /** One slot per lane, index 0 = lane 1. `null` = empty lane. */
  lanes: (string | null)[];
}

export type ResultStatus = "OK" | "DQ" | "NS";

/**
 * One person's watch on one lane.
 *
 * A lane is timed by whoever is standing at it — often two or three people,
 * plus a coach — so a race produces several times for the same swim and the
 * official one is worked out from them. Each watch is its own record: nobody
 * overwrites anybody, a timer can correct their own time and only their own,
 * and two timers on different lanes never touch the same thing.
 *
 * `id` is derived from heat, lane and timer rather than generated, so sending
 * the same watch twice — a retry after the wifi drops at the wall — is a
 * no-op instead of a duplicate.
 */
export interface WatchTime {
  id: string;
  eventId: string;
  heatId: string;
  /** 1-based lane number. The watch times a lane; who was in it comes from the heat. */
  lane: number;
  /** Whoever took it: a device today, a signed-in timer later. */
  timerId: string;
  /** Elapsed time in milliseconds, measured on the timer's own device. */
  timeMs: number;
  recordedAt: number;
  /** How it arrived: a stopwatch tap, or typed in afterwards. */
  source: "stopwatch" | "typed";
  /**
   * Who this timer says was actually in the lane, when that isn't who the heat
   * has there — an exhibition swim, a swimmer in the wrong lane, a late entry.
   *
   * Deliberately a property of the *watch* and not of the heat. A timer
   * correcting what they saw must never rewrite the lineup: the coach's
   * running order is the coach's, and two timers disagreeing about lane 4 is
   * information worth keeping rather than a fight to settle.
   */
  athleteId?: string;
  /**
   * When the watch was started and stopped, on the timer's own clock.
   *
   * Nothing reads these yet. They're recorded because they can't be recovered
   * afterwards, and because reconciling six lanes timed on six phones
   * eventually needs to know whether two watches were even running at the same
   * moment.
   */
  startedAt?: number;
  stoppedAt?: number;
}

export function watchId(heatId: string, lane: number, timerId: string): string {
  return `${heatId}:${lane}:${timerId}`;
}

/**
 * A judgement about a swim that no stopwatch can make: a disqualification, a
 * no-show, or a coach setting the time by hand because the watches were wrong.
 *
 * One per lane, and last-write-wins is right for it — unlike a watch time,
 * it's a deliberate decision, and the most recent one is the one that stands.
 */
export interface Ruling {
  id: string;
  eventId: string;
  heatId: string;
  lane: number;
  status: ResultStatus;
  /** Set when a coach overrides the watches outright. */
  timeMs?: number;
  decidedAt: number;
}

export function rulingId(heatId: string, lane: number): string {
  return `${heatId}:${lane}`;
}

/**
 * The official result for a lane, as accepted by whoever is running the meet.
 *
 * Watches are evidence and rulings are judgements; this is the decision. An
 * administrator looks at what the watches worked out, and either accepts it or
 * corrects it and accepts that. Nothing is official until they do.
 *
 * Storing the acceptance rather than deriving everything is what makes late
 * times harmless. A timer's phone that was offline all afternoon can push its
 * watches whenever it reconnects: the meet reads its results from here, so a
 * watch arriving afterwards changes nothing on its own. It's still recorded,
 * still timestamped, and still visible — so in the rare case it *should* change
 * something, there's enough on file to reopen the question deliberately.
 *
 * `athleteId` is stored rather than read off the heat because correcting who
 * was in a lane is one of the things acceptance is for.
 */
export interface AcceptedResult {
  /** One per lane, like a ruling: `heatId:lane`. */
  id: string;
  eventId: string;
  heatId: string;
  lane: number;
  athleteId: string;
  timeMs: number;
  status: ResultStatus;
  acceptedAt: number;
  /** The account that accepted it. */
  acceptedBy?: string;
  /**
   * What the watches said at the moment of acceptance.
   *
   * Kept so the record can answer "what did they actually see?" later, when
   * the watches themselves may have grown by one that arrived late.
   */
  fromWatches?: {
    timeMs: number;
    watchCount: number;
    method: Result["method"];
  };
}

export function acceptedResultId(heatId: string, lane: number): string {
  return `${heatId}:${lane}`;
}

/**
 * The official time for a lane, worked out from the watches on it.
 *
 * Derived rather than stored, which is what makes concurrent timing safe:
 * every device computes the same answer from the same set of watches, so
 * there's nothing to conflict over.
 */
export interface Result {
  eventId: string;
  heatId: string;
  athleteId: string;
  /** 1-based lane number. */
  lane: number;
  /** Elapsed time in milliseconds. */
  timeMs: number;
  status: ResultStatus;
  recordedAt: number;
  /** How the time was arrived at, for anyone asking why it says what it says. */
  method: "single" | "average" | "median" | "official";
  /** How many watches stood behind it. */
  watchCount: number;
  /** True when no stopwatch was involved at all. */
  manual?: boolean;
  /**
   * True when nobody was seeded in this lane and the swim is credited on a
   * timer's word alone. Worth showing: it's a real time, and it's also the
   * one kind of result a coach might want to look at twice.
   */
  attributed?: boolean;
  /**
   * Set when an administrator has accepted this lane. Until then the numbers
   * are a proposal worked out from the watches, and nothing is official.
   */
  accepted?: boolean;
  acceptedAt?: number;
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
 * school is putting in the 200 Free is worth something. "everyone" suits a
 * friendly meet where lineups are exchanged anyway; "own-team" keeps each
 * coach to their own until the racing starts.
 *
 * Results are unaffected either way — those are public once they exist.
 */
export type EntryVisibility = "everyone" | "own-team";

/**
 * How places turn into points. Nothing computes these yet — the shape is here
 * so a meet can carry the intent while scoring is built.
 */
export interface ScoringRules {
  /** Points by place, best first: [6, 4, 3, 2, 1] for a dual meet. */
  individual: number[];
  /** Relays usually score differently, and fewer of them place: [8, 4]. */
  relay: number[];
  /** Dual meets score the girls' and boys' halves as separate contests. */
  separateByGender: boolean;
}

export interface MeetOptions {
  laneCount: LaneCount;
  /**
   * Whether the lineup carries a Diving event. Kept in step with the events
   * themselves: removing the last Diving event switches this off.
   */
  includeDiving: boolean;
  /**
   * Which gender swims first in each pair of a split lineup. Flipping it
   * reorders the existing events rather than rebuilding them, so entries and
   * recorded times survive.
   */
  leadGender: Gender;
  limits: EntryLimits;
  entryVisibility: EntryVisibility;
  /**
   * Whether a swimmer whose account is linked may enter and scratch
   * themselves. Off by default: most coaches pick the lineup, and the ones who
   * hand it over want to say so deliberately.
   */
  athletesMayEnter: boolean;
  /** Absent until somebody sets it up; nothing scores a meet yet. */
  scoring?: ScoringRules;
}

/** 6-4-3-2-1 individual, 8-4 relay, girls and boys scored apart. */
export const DUAL_MEET_SCORING: ScoringRules = {
  individual: [6, 4, 3, 2, 1],
  relay: [8, 4],
  separateByGender: true,
};

/**
 * A stopwatch run in progress. Anchored to an absolute epoch timestamp rather
 * than an accumulating counter so the clock stays correct across a reload, a
 * backgrounded tab, or an iOS screen lock.
 */
export interface TimerState {
  heatId: string;
  startedAt: number;
}

export interface Progress {
  eventIndex: number;
  heatIndex: number;
}

export interface MeetDoc {
  version: number;
  id: string;
  /**
   * The teams racing, as references.
   *
   * A meet belongs to none of them. An inter-squad meet names one team, a dual
   * two, an invitational as many as turn up — and every one of them sees the
   * same meet rather than a copy, which is the whole reason this is a list of
   * ids and not an owner plus some labels.
   */
  teamIds: string[];
  /** Whose pool it is, when that matters. Always one of `teamIds`. */
  hostTeamId?: string;
  /** The account that set it up, for "my meets" and for who may edit it. */
  createdBy?: string;
  name: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  type: MeetType;
  /** The course times in this meet were swum in. */
  course: MeetCourse;
  /** Where it's being swum, free text — e.g. "Cactus Aquatic Center". */
  location?: string;
  options: MeetOptions;
  /** Order of this array is the order events are swum. */
  events: MeetEvent[];
  entries: Entries;
  heats: Heat[];
  /** Every watch taken in this meet. Results are derived from these. */
  watches: WatchTime[];
  /** Per-lane judgements: DQs, no-shows, and coach overrides. */
  rulings: Ruling[];
  /** Lanes an administrator has signed off. Absent means not yet official. */
  results: AcceptedResult[];
  progress: Progress;
  timer: TimerState | null;
  /**
   * When this meet was deleted, if it was.
   *
   * A delete has to be a fact the server can hold, not the absence of one:
   * a row that simply vanishes looks identical to a row another device hasn't
   * uploaded yet, so the next sync would put it back. A deleted meet keeps its
   * id and its name and loses everything else.
   */
  deletedAt?: number | null;
  /** Local last-modified time, used to resolve sync conflicts. */
  updatedAt: number;
}

export const MEET_DOC_VERSION = 8;

export function isDeleted(meet: Pick<MeetDoc, "deletedAt">): boolean {
  return meet.deletedAt != null;
}

/* ------------------------------------------------------------------ naming */

export function athleteName(s: Athlete): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

/**
 * Roster order. Whichever name isn't being sorted on breaks the tie, so
 * siblings — same surname, different given name — always land in the same
 * order rather than shuffling between renders.
 *
 * Display-only: the stored roster keeps its import order, so sorting never
 * churns the document or the sync.
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

export function eventName(e: MeetEvent): string {
  if (e.name) return e.name;
  const prefix = e.gender === "Open" ? "" : e.gender === "M" ? "Boys " : "Girls ";
  // Diving carries a placeholder distance, so don't write it out.
  if (isDiving(e)) return `${prefix}Diving`;
  return `${prefix}${e.distance} ${e.stroke}`;
}

/** "Dual vs Central" / "Inter-squad" — the subtitle in the meet list. */
export function meetSubtitle(meet: Pick<MeetDoc, "type">): string {
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

/** Whether a athlete is eligible for an event, given its gender restriction. */
export function isEligible(athlete: Athlete, event: MeetEvent): boolean {
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


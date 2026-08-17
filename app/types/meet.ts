/**
 * Core data model.
 *
 * Two kinds of document. The **team** is season-long and owns the roster; a
 * **meet** is one day's racing and refers to swimmers by id only. The roster is
 * the single source of truth for who someone is, so fixing a spelling in March
 * fixes January's results too — and removing someone archives them rather than
 * deleting, since live results still point at their id.
 *
 * Everything here is plain JSON — no Map, Set, or Date — so the same value
 * round-trips through IndexedDB and the server unchanged.
 */

export type Gender = "M" | "F";

/** Events can be restricted to one gender, or open to everyone. */
export type EventGender = Gender | "Open";

export type Stroke = "Free" | "Back" | "Breast" | "Fly" | "IM";

export const STROKES: Stroke[] = ["Free", "Back", "Breast", "Fly", "IM"];

export type LaneCount = 4 | 6 | 8;

export const LANE_COUNTS: LaneCount[] = [4, 6, 8];

/**
 * How the lane buttons are arranged while running a heat. The two list
 * layouts put the lanes in a single column in pool order, so whoever is
 * watching from the side maps a finish straight onto a button without
 * having to work out which column it's in.
 */
export type LaneLayout = "grid" | "list-asc" | "list-desc";

export const LANE_LAYOUTS: LaneLayout[] = ["grid", "list-asc", "list-desc"];

/** Lane numbers in the order they should be drawn for a layout. */
export function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
}

/* -------------------------------------------------------------------- team */

export interface Swimmer {
  id: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  /** School year as entered — "9", "Fr", "Senior", whatever the CSV had. */
  year: string;
  /** Optional squad/side for an inter-squad meet (e.g. "Blue" / "Gold"). */
  squad?: string;
  /**
   * Off the roster, but kept so past results can still resolve their name.
   * Archived swimmers are hidden from registration and lane pickers.
   */
  archived: boolean;
}

/** The season-long document: who's on the team, and what the team is called. */
export interface TeamDoc {
  version: number;
  id: string;
  name: string;
  /** Free-text season label, e.g. "2026-27". */
  season: string;
  swimmers: Swimmer[];
  updatedAt: number;
  syncedAt: number | null;
}

export const TEAM_DOC_VERSION = 1;

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

export interface MeetEvent {
  id: string;
  distance: number;
  stroke: Stroke;
  gender: EventGender;
  /** Optional label override; otherwise derived from distance/stroke/gender. */
  name?: string;
}

/** eventId -> swimmerIds registered in that event. */
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

export interface Result {
  id: string;
  eventId: string;
  heatId: string;
  swimmerId: string;
  /** 1-based lane number. */
  lane: number;
  /** Elapsed time in milliseconds. */
  timeMs: number;
  status: ResultStatus;
  recordedAt: number;
  /** True when the time was typed in rather than captured by the stopwatch. */
  manual?: boolean;
}

export interface MeetOptions {
  laneCount: LaneCount;
  laneLayout: LaneLayout;
}

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
  /** The team whose roster this meet's swimmer ids belong to. */
  teamId: string;
  name: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  type: MeetType;
  /** Who they're swimming, when that applies. */
  opponent?: string;
  options: MeetOptions;
  /** Order of this array is the order events are swum. */
  events: MeetEvent[];
  entries: Entries;
  heats: Heat[];
  results: Result[];
  progress: Progress;
  timer: TimerState | null;
  /** Local last-modified time, used to resolve sync conflicts. */
  updatedAt: number;
  /** `updatedAt` as of the last successful sync, or null if never synced. */
  syncedAt: number | null;
}

export const MEET_DOC_VERSION = 2;

/** Enough of a meet to render the schedule without loading the whole thing. */
export interface MeetSummary {
  id: string;
  name: string;
  date: string;
  type: MeetType;
  opponent?: string;
  updatedAt: number;
}

/* ------------------------------------------------------------------ naming */

export function swimmerName(s: Swimmer): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

/** "Smith, J." — fits in a lane button without wrapping. */
export function shortName(s: Swimmer): string {
  const initial = s.firstName ? `${s.firstName[0]}.` : "";
  return `${s.lastName}${initial ? `, ${initial}` : ""}`;
}

export function eventName(e: MeetEvent): string {
  if (e.name) return e.name;
  const prefix = e.gender === "Open" ? "" : e.gender === "M" ? "Boys " : "Girls ";
  return `${prefix}${e.distance} ${e.stroke}`;
}

/** "Dual vs Central" / "Inter-squad" — the subtitle in the meet list. */
export function meetSubtitle(meet: Pick<MeetDoc, "type" | "opponent">): string {
  const label = meetTypeLabel(meet.type);
  return meet.opponent ? `${label} vs ${meet.opponent}` : label;
}

/** Whether a swimmer is eligible for an event, given its gender restriction. */
export function isEligible(swimmer: Swimmer, event: MeetEvent): boolean {
  return event.gender === "Open" || event.gender === swimmer.gender;
}

/**
 * Resolve a swimmer id against the roster. Results from past meets can point
 * at archived swimmers, so this deliberately looks through the whole roster
 * rather than just the active part.
 */
export function findSwimmer(
  swimmers: Swimmer[],
  id: string | null | undefined,
): Swimmer | undefined {
  if (!id) return undefined;
  return swimmers.find((s) => s.id === id);
}

/** A placeholder for a swimmer id no longer in the roster at all. */
export function missingSwimmerLabel(id: string): string {
  return `(removed ${id.slice(0, 4)})`;
}

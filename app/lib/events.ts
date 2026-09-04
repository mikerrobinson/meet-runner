import { generateId } from "./id";
import { DIVING_DISTANCE, isDiving, raceKey } from "~/types/meet";
import type { EventGender, Gender, MeetEvent, Stroke } from "~/types/meet";

/**
 * A standard high-school dual meet, in the order it's swum — relays included,
 * which is where they actually fall: medley opens, free relay closes, and
 * diving breaks up the middle after the 50 free.
 */
const DUAL_MEET_ORDER: Array<{ distance: number; stroke: Stroke }> = [
  { distance: 200, stroke: "Medley Relay" },
  { distance: 200, stroke: "Free" },
  { distance: 200, stroke: "IM" },
  { distance: 50, stroke: "Free" },
  { distance: DIVING_DISTANCE, stroke: "Diving" },
  { distance: 100, stroke: "Fly" },
  { distance: 100, stroke: "Free" },
  { distance: 500, stroke: "Free" },
  { distance: 200, stroke: "Free Relay" },
  { distance: 100, stroke: "Back" },
  { distance: 100, stroke: "Breast" },
  { distance: 400, stroke: "Free Relay" },
];

/** Races in the standard order — half the event count of a split lineup. */
export function dualMeetRaceCount(includeDiving: boolean): number {
  return includeDiving
    ? DUAL_MEET_ORDER.length
    : DUAL_MEET_ORDER.filter((e) => e.stroke !== "Diving").length;
}

export function makeEvent(
  distance: number,
  stroke: Stroke,
  gender: EventGender = "Open",
): MeetEvent {
  return { id: generateId(), distance, stroke, gender };
}

export function otherGender(gender: Gender): Gender {
  return gender === "F" ? "M" : "F";
}

/**
 * Build a default event order.
 *
 * "split" is the high-school norm: each race swum twice, girls and boys back to
 * back, with `leadGender` going first. "open" collapses that to one race per
 * event, which suits an inter-squad meet or a time trial.
 */
export function defaultEvents(
  mode: "split" | "open" = "split",
  leadGender: Gender = "F",
  includeDiving = true,
): MeetEvent[] {
  const order = includeDiving
    ? DUAL_MEET_ORDER
    : DUAL_MEET_ORDER.filter((e) => e.stroke !== "Diving");

  if (mode === "open") {
    return order.map((e) => makeEvent(e.distance, e.stroke, "Open"));
  }
  const second = otherGender(leadGender);
  return order.flatMap((e) => [
    makeEvent(e.distance, e.stroke, leadGender),
    makeEvent(e.distance, e.stroke, second),
  ]);
}

/**
 * Whether a lineup is split by gender, so diving can be added to match. An
 * empty lineup counts as split — that's the high-school default everything
 * else here assumes.
 */
function isSplitLineup(events: MeetEvent[]): boolean {
  return events.length === 0 || events.some((e) => e.gender !== "Open");
}

/**
 * Add Diving to a lineup, in the place a program would put it: straight after
 * the 50 free, or at the end if there isn't one. Matches the lineup's own
 * shape — a gendered pair in a split meet, a single event otherwise.
 */
export function withDiving(
  events: MeetEvent[],
  leadGender: Gender,
): MeetEvent[] {
  if (events.some(isDiving)) return events;

  const diving = isSplitLineup(events)
    ? [
        makeEvent(DIVING_DISTANCE, "Diving", leadGender),
        makeEvent(DIVING_DISTANCE, "Diving", otherGender(leadGender)),
      ]
    : [makeEvent(DIVING_DISTANCE, "Diving", "Open")];

  const lastFifty = events.reduce(
    (found, e, i) => (e.distance === 50 && e.stroke === "Free" ? i : found),
    -1,
  );
  const at = lastFifty >= 0 ? lastFifty + 1 : events.length;
  return [...events.slice(0, at), ...diving, ...events.slice(at)];
}

export function withoutDiving(events: MeetEvent[]): MeetEvent[] {
  return events.filter((e) => !isDiving(e));
}

/**
 * Reorder an existing lineup so `leadGender` swims first in every pair.
 *
 * Deliberately a reorder, not a rebuild: event ids are preserved, so entries
 * and recorded times come along. Runs of events sharing a race stay together
 * and keep their position in the meet; anything unpaired is left alone.
 */
export function orderByLeadGender(
  events: MeetEvent[],
  leadGender: Gender,
): MeetEvent[] {
  const ordered: MeetEvent[] = [];

  for (let i = 0; i < events.length; ) {
    const key = raceKey(events[i]);
    let end = i;
    while (end < events.length && raceKey(events[end]) === key) end++;

    const run = events.slice(i, end);
    // Only a gendered pair has an order worth choosing.
    const lead = run.filter((e) => e.gender === leadGender);
    const rest = run.filter((e) => e.gender !== leadGender);
    ordered.push(...lead, ...rest);

    i = end;
  }

  return ordered;
}

/** Distances offered in the "add event" picker. */
export const COMMON_DISTANCES = [25, 50, 100, 200, 400, 500, 800, 1000, 1650];

/** Relays are only ever swum at these distances, so the picker follows suit. */
export const RELAY_DISTANCES = [100, 200, 400, 800];

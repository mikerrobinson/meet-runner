import { generateId } from "./id";
import { raceKey } from "~/types/meet";
import type { EventGender, Gender, MeetEvent, Stroke } from "~/types/meet";

/**
 * A standard high-school dual meet, in the order it's swum — relays included,
 * which is where they actually fall: medley opens, free relay closes.
 */
const DUAL_MEET_ORDER: Array<{ distance: number; stroke: Stroke }> = [
  { distance: 200, stroke: "Medley Relay" },
  { distance: 200, stroke: "Free" },
  { distance: 200, stroke: "IM" },
  { distance: 50, stroke: "Free" },
  { distance: 100, stroke: "Fly" },
  { distance: 100, stroke: "Free" },
  { distance: 500, stroke: "Free" },
  { distance: 200, stroke: "Free Relay" },
  { distance: 100, stroke: "Back" },
  { distance: 100, stroke: "Breast" },
  { distance: 400, stroke: "Free Relay" },
];

/** Races in the standard order — half the event count of a split lineup. */
export const DUAL_MEET_RACE_COUNT = DUAL_MEET_ORDER.length;

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
): MeetEvent[] {
  if (mode === "open") {
    return DUAL_MEET_ORDER.map((e) => makeEvent(e.distance, e.stroke, "Open"));
  }
  const second = otherGender(leadGender);
  return DUAL_MEET_ORDER.flatMap((e) => [
    makeEvent(e.distance, e.stroke, leadGender),
    makeEvent(e.distance, e.stroke, second),
  ]);
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

import { generateId } from "./id";
import { DIVING_DISTANCE, isDiving, isRelay, raceKey } from "~/types/meet";
import type {
  EventGender,
  Gender,
  MeetCourse,
  MeetEvent,
  Stroke,
} from "~/types/meet";

/**
 * A standard high-school dual meet, in the order it's swum — relays included,
 * which is where they actually fall: medley opens, free relay closes, and
 * diving breaks up the middle after the 50 free.
 *
 * Written in yards, the US high-school norm. Every distance here is swum
 * unchanged in a metric pool bar one: the distance event is a 400 rather than
 * a 500, which is what `dualMeetOrder` swaps.
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

function isYards(course: MeetCourse): boolean {
  return course === "SCY";
}

/** The standard order as plain races, for building a lineup or naming one. */
export function standardOrder(
  course: MeetCourse,
  includeDiving = true,
): Array<{ distance: number; stroke: Stroke }> {
  return DUAL_MEET_ORDER.filter(
    (e) => includeDiving || e.stroke !== "Diving",
  ).map((e) =>
    !isYards(course) && e.distance === 500 && e.stroke === "Free"
      ? { ...e, distance: 400 }
      : e,
  );
}

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
export function defaultEvents({
  mode = "split",
  leadGender = "F",
  includeDiving = true,
  course = "SCY",
}: {
  mode?: "split" | "open";
  leadGender?: Gender;
  includeDiving?: boolean;
  course?: MeetCourse;
} = {}): MeetEvent[] {
  const order = standardOrder(course, includeDiving);

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

/**
 * Distances with a counterpart in the other measure. Only these three differ:
 * everything from the 25 up to the 200 is swum at the same number in either
 * pool, which is why a lineup converts so cleanly.
 */
const DISTANCE_PAIRS: Array<[yards: number, metres: number]> = [
  [500, 400],
  [1000, 800],
  [1650, 1500],
];

/**
 * Rewrite a lineup's distances when a meet moves between yards and metres —
 * the 500 free becomes a 400, the mile becomes the metric mile.
 *
 * Event ids are kept, so entries, heats and any recorded times come along.
 * Relays are left alone: a 400 free relay is a 400 free relay in either pool,
 * and converting it would silently turn it into a 500.
 */
export function convertDistances(
  events: MeetEvent[],
  from: MeetCourse,
  to: MeetCourse,
): MeetEvent[] {
  if (isYards(from) === isYards(to)) return events;

  const toMetres = isYards(from);
  const swap = new Map(
    DISTANCE_PAIRS.map(([yards, metres]) =>
      toMetres ? [yards, metres] : [metres, yards],
    ),
  );

  return events.map((event) => {
    if (isRelay(event) || isDiving(event)) return event;
    const distance = swap.get(event.distance);
    return distance ? { ...event, distance } : event;
  });
}

/**
 * Distances offered in the "add event" picker, for the course this meet is
 * swum in — a yards pool has no 400 free, a metric one no 500. The meet knows
 * its course, so the picker doesn't have to offer both and hope.
 */
export function distancesFor(course: MeetCourse): number[] {
  return isYards(course)
    ? [25, 50, 100, 200, 500, 1000, 1650]
    : [25, 50, 100, 200, 400, 800, 1500];
}

/**
 * Relays are only ever swum at these distances, so the picker follows suit.
 * The same four in either course — a 200 free relay is a 200 free relay.
 */
export const RELAY_DISTANCES = [100, 200, 400, 800];

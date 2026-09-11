import { generateId } from "./id";
import { DIVING_DISTANCE, isDiving, isRelay, raceKey } from "~/types/meet";
import type {
  EventGender,
  Gender,
  MeetCourse,
  MeetDoc,
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

/* ------------------------------------------------------------ entry limits */

export interface EntryTally {
  individual: number;
  relay: number;
  total: number;
}

/** What a swimmer is already in, counted the way the limits are written. */
export function tallyEntries(
  meet: Pick<MeetDoc, "entries" | "events">,
  athleteId: string,
): EntryTally {
  const byId = new Map(meet.events.map((e) => [e.id, e] as const));
  let individual = 0;
  let relay = 0;

  for (const [eventId, ids] of Object.entries(meet.entries)) {
    if (!ids.includes(athleteId)) continue;
    const event = byId.get(eventId);
    // Diving holds a place in the running order but isn't a swim, so it
    // doesn't count against a swimming cap.
    if (!event || isDiving(event)) continue;
    if (isRelay(event)) relay += 1;
    else individual += 1;
  }

  return { individual, relay, total: individual + relay };
}

/**
 * Why a swimmer can't be added to an event, or null if they can.
 *
 * Returns the reason rather than a boolean because every caller wants to say
 * it out loud — a greyed-out cell that won't explain itself is how a coach
 * ends up counting on their fingers.
 *
 * Counts what they'd have *after* the entry, and ignores an event they're
 * already in, so re-checking an existing entry never reports a breach.
 */
export function whyNotEnter(
  meet: Pick<MeetDoc, "entries" | "events" | "options">,
  athleteId: string,
  eventId: string,
): string | null {
  const event = meet.events.find((e) => e.id === eventId);
  if (!event) return "That race isn't in this meet.";
  if ((meet.entries[eventId] ?? []).includes(athleteId)) return null;
  if (isDiving(event)) return null;

  const { limits } = meet.options;
  const tally = tallyEntries(meet, athleteId);
  const relay = isRelay(event);

  if (relay && limits.maxRelays !== undefined && tally.relay >= limits.maxRelays) {
    return `Already in ${tally.relay} relay${tally.relay === 1 ? "" : "s"}, and this meet allows ${limits.maxRelays}.`;
  }
  if (
    !relay &&
    limits.maxIndividual !== undefined &&
    tally.individual >= limits.maxIndividual
  ) {
    return `Already in ${tally.individual} individual event${tally.individual === 1 ? "" : "s"}, and this meet allows ${limits.maxIndividual}.`;
  }
  if (limits.maxTotal !== undefined && tally.total >= limits.maxTotal) {
    return `Already in ${tally.total} events, and this meet allows ${limits.maxTotal}.`;
  }

  return null;
}

/**
 * Whether a team has filled its allowance in a race.
 *
 * Separate from the per-swimmer check because it's a different question with a
 * different answer: a swimmer under their own cap can still be turned away
 * because their team already has enough in that heat.
 */
export function teamFullFor(
  meet: Pick<MeetDoc, "entries" | "options">,
  eventId: string,
  teamAthleteIds: Set<string>,
): boolean {
  const cap = meet.options.limits.maxPerTeamPerEvent;
  if (cap === undefined) return false;
  const entered = (meet.entries[eventId] ?? []).filter((id) =>
    teamAthleteIds.has(id),
  );
  return entered.length >= cap;
}

/**
 * Entries in an event, split by whether the swimmer still exists.
 *
 * These come apart more often than you'd hope. Entries reference athletes by
 * id, so re-importing a roster — which mints new ids — leaves the old entries
 * pointing at people who are no longer listed. The registration grid draws a
 * row per athlete, so an orphaned entry is invisible there while still sitting
 * in the document, which is how a race can read "9 entered" and show three
 * ticks.
 *
 * Counting them separately is what lets a screen say so instead of quietly
 * disagreeing with the one next to it.
 */
export function entrySplit(
  meet: Pick<MeetDoc, "entries">,
  eventId: string,
  known: Set<string>,
): { entered: number; orphaned: number } {
  const ids = meet.entries[eventId] ?? [];
  const entered = ids.filter((id) => known.has(id)).length;
  return { entered, orphaned: ids.length - entered };
}

import { done, eq } from "./harness.ts";
import { earliestAllowed, newVisitingAthlete, runningOrder } from "../app/lib/timer.ts";
import { grantExpiry } from "../app/lib/grants.server.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { buildHeats } from "../app/lib/heats.ts";
import type { Heat } from "../app/types/meet.ts";

/* ------------------------------------------------------- the running order */

const events = defaultEvents({ course: "SCY" }).slice(0, 3);
// Twelve entrants over six lanes is two heats; four is one. The middle event
// is left unseeded, which is the case that matters.
const heats: Heat[] = [
  ...buildHeats(events[0].id, ["a1", "a2", "a3", "a4", "a5", "a6", "a7"], 6),
  ...buildHeats(events[2].id, ["a1", "a2"], 6),
];

{
  const order = runningOrder(events, heats);
  eq(order.length, 3, "two heats for the first event, one for the third");
  eq(
    order.map((stop) => stop.event.id),
    [events[0].id, events[0].id, events[2].id],
    "heats come in event order, not heat-id order",
  );
  eq(
    order.map((stop) => `${stop.number}/${stop.of}`),
    ["1/2", "2/2", "1/1"],
    "each heat knows where it sits within its own event",
  );
  // An event nobody has seeded has nothing to time. Offering a stopwatch for
  // it is how a time gets recorded against a heat that doesn't exist.
  eq(
    order.some((stop) => stop.event.id === events[1].id),
    false,
    "an event with no heats is skipped entirely",
  );
}

eq(runningOrder([], []), [], "nothing to swim, nothing to time");
eq(runningOrder(events, []), [], "events without heats produce no stops");

// Heats arriving out of order still come back in the order they'll be swum:
// the snapshot is assembled from rows, and rows have no inherent order.
{
  const shuffled = [...heats].reverse();
  eq(
    runningOrder(events, shuffled).map((stop) => stop.heat.index),
    [0, 1, 0],
    "heat order is by index, however the rows arrived",
  );
}

/* ------------------------------------------------- how far back you may go */

// The rule timers actually live under: you may fix the time you just took,
// and you may not reach back into an event that's already been reconciled.
eq(earliestAllowed({ at: 0, submitted: -1 }), 0, "before anything is submitted, only heat one");
eq(earliestAllowed({ at: 1, submitted: 0 }), 0, "having submitted heat one, you may return to it");
eq(earliestAllowed({ at: 5, submitted: 4 }), 3, "one heat behind the last submission");
eq(earliestAllowed({ at: 9, submitted: 8 }), 7, "and no further, however far along the meet is");
// Browsing ahead to look at what's coming must not strand you: the floor
// follows what you've *submitted*, never where you've wandered.
eq(
  earliestAllowed({ at: 20, submitted: 2 }),
  1,
  "looking ahead doesn't move the floor",
);

/* -------------------------------------------------------- names typed in */

{
  const dana = newVisitingAthlete("Dana Reyes", "Horizon", "F");
  eq(dana.firstName, "Dana", "given name");
  eq(dana.lastName, "Reyes", "family name");
  eq(dana.team, "Horizon", "and the team they swim for");
  eq(dana.birthDate, undefined, "a timer is never asked for a birth date");
}
{
  // Deck reality: one name, or three, or a stray double space.
  eq(newVisitingAthlete("Cher", "Horizon", "F").firstName, "Cher", "a single name is the given name");
  eq(newVisitingAthlete("Cher", "Horizon", "F").lastName, "", "with nothing after it");
  const long = newVisitingAthlete("  Mary  Jo   Van Damme ", "Horizon", "F");
  eq(long.firstName, "Mary Jo Van", "everything but the last word");
  eq(long.lastName, "Damme", "is the family name");
}
eq(
  newVisitingAthlete("Dana Reyes", "  ", "M").team,
  undefined,
  "no team given means ours, which is an absent label",
);

/* ---------------------------------------------------------- grant expiry */

// The QR code has to outlive the meet it's taped to, in every timezone the
// app might be used in, and die soon after.
{
  // A code printed the day before the meet.
  const printed = Date.parse("2026-09-11T18:00:00Z");
  const expires = grantExpiry("2026-09-12", printed);
  const meetMorning = Date.parse("2026-09-12T14:00:00Z"); // 7am in Arizona
  const meetEvening = Date.parse("2026-09-13T05:00:00Z"); // 10pm, running late
  eq(expires > meetMorning, true, "still valid when the meet starts");
  eq(expires > meetEvening, true, "and when it's running late into the night");
  eq(
    expires < Date.parse("2026-09-14T01:00:00Z"),
    true,
    "but dead within a day and a half — a photo of the code goes stale",
  );
}

// The one that actually bit: a code printed for a meet already in the past was
// issued expired, and the only symptom was a QR that didn't work.
{
  const now = Date.parse("2026-09-07T20:00:00Z");
  const forOldMeet = grantExpiry("2026-08-15", now);
  eq(forOldMeet > now, true, "a code for a past meet is not born expired");
  eq(
    forOldMeet >= now + 12 * 60 * 60 * 1000,
    true,
    "and lasts long enough to be worth printing",
  );
  eq(
    grantExpiry("not-a-date", now) > now,
    true,
    "nor is one for a meet with an unreadable date",
  );
  // The floor must not extend a normal meet's code beyond its two days.
  eq(
    grantExpiry("2026-09-12", Date.parse("2026-09-11T18:00:00Z")),
    Date.parse("2026-09-14T00:00:00Z"),
    "a meet in the future is still governed by its own date",
  );
}

done();

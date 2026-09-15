/**
 * Where a timing screen lives.
 *
 * `/meets/{meetId}/timers/{timerId}/{event}/{heat}/{lane}` — the same shape as
 * the endpoint that lane posts to, and for the same reason: everything about
 * where a timer is standing belongs in the address rather than on the device.
 * Moving to the next heat is then a link, going back is the back button, and
 * the screen holds no idea of "where am I" that could disagree with the URL.
 */

import type { Snapshot } from "./timer";
import { runningOrder, type Stop } from "./timer";

export function stopPath(
  meetId: string,
  timerId: string,
  stop: Stop,
  lane: number,
): string {
  return (
    `/meets/${encodeURIComponent(meetId)}/timers/${encodeURIComponent(timerId)}` +
    `/${stop.event.position + 1}/${stop.heat}/${lane}`
  );
}

/**
 * Where a timer starts: the first heat with anything seeded in it.
 *
 * Not simply the first event. A meet's programme opens with relays that are
 * often unseeded, and dropping somebody on "event 1, heat 1 — nobody here"
 * makes them think the app is broken before they have pressed anything.
 */
export function firstStopPath(
  snapshot: Snapshot,
  meetId: string,
  timerId: string,
  lane: number,
): string {
  // The first heat with anything in it — which, since a heat *is* its seeds,
  // is simply the first heat there is.
  const order = runningOrder(snapshot.events, snapshot.seeds);
  const first = order[0];

  // A meet with no heats seeded at all still has to go somewhere, and event 1
  // heat 1 is where seeding will put the first one.
  if (!first) {
    return `/meets/${encodeURIComponent(meetId)}/timers/${encodeURIComponent(timerId)}/1/1/${lane}`;
  }
  return stopPath(meetId, timerId, first, lane);
}

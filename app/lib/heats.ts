import { generateId } from "./id";
import { eventTouched, seedsForEvent, type TimingRows } from "./timing";
import type { LaneCount, Seed } from "~/types/meet";

/**
 * Lane assignment order, fastest lane first. Standard practice puts the top
 * seed in the middle of the pool and works outward, alternating sides: six
 * lanes seed 3-4-2-5-1-6, five lanes 3-2-4-1-5. An even pool has no true
 * centre, so its first pair leans to the high side.
 */
export function laneOrder(laneCount: LaneCount): number[] {
  const middle = Math.floor((laneCount + 1) / 2);
  const even = laneCount % 2 === 0;
  const order = [middle];

  for (let step = 1; order.length < laneCount; step++) {
    for (const lane of even
      ? [middle + step, middle - step]
      : [middle - step, middle + step]) {
      if (lane >= 1 && lane <= laneCount) order.push(lane);
    }
  }

  return order;
}

/**
 * Split swimmers into heats and assign lanes.
 *
 * Heats are numbered in swum order, 1-based, and any short heat comes first —
 * that's how meets actually run it, so the last heat is full. Within a heat,
 * swimmers fill lanes from the middle outward.
 *
 * One seed per swimmer, and none for the lanes nobody is in: a lane with
 * nobody in it isn't a planned swim, and a heat is the distinct heats across
 * the seeds rather than a row of its own.
 */
export function buildSeeds(
  meetId: string,
  eventId: string,
  athleteIds: string[],
  laneCount: LaneCount,
): Seed[] {
  if (athleteIds.length === 0) return [];

  const order = laneOrder(laneCount);
  const heatCount = Math.ceil(athleteIds.length / laneCount);
  const remainder = athleteIds.length % laneCount;
  const firstHeatSize = remainder === 0 ? laneCount : remainder;

  const seeds: Seed[] = [];
  let cursor = 0;

  for (let index = 0; index < heatCount; index++) {
    const size = index === 0 ? firstHeatSize : laneCount;
    const group = athleteIds.slice(cursor, cursor + size);
    cursor += size;

    group.forEach((athleteId, i) => {
      seeds.push({
        id: generateId(),
        meetId,
        eventId,
        heat: index + 1,
        lane: order[i],
        athleteId,
      });
    });
  }

  return seeds;
}

/** Fisher-Yates, used when the coach asks to reshuffle an event's lanes. */
export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Seed an event's lanes again, or refuse to.
 *
 * It refuses once anything has been recorded against the event. Reseeding used
 * to clear the event's watches and rulings to make room, and on a deck with
 * three timers on it that is somebody's whole afternoon — deleted from one
 * device and synced to the rest.
 *
 * Where a swimmer keeps their lane, the seed keeps its id. A fresh id orphans
 * every watch and result pointing at the old one: they stay in the meet, count
 * towards things, and render nowhere. Only somebody who actually moved gets a
 * new row, and nothing can have been recorded against them anyway.
 *
 * Returns null when it refuses, so the caller can say so rather than appearing
 * to work.
 */
export function reseedEvent(
  rows: TimingRows,
  meetId: string,
  eventId: string,
  entrants: string[],
  laneCount: LaneCount,
): Seed[] | null {
  if (eventTouched(rows, eventId)) return null;

  // Keyed by where the swim *is*, so a swimmer who lands back in the same lane
  // of the same heat keeps the row they had.
  const existing = new Map(
    seedsForEvent(rows, eventId).map((s) => [`${s.heat}/${s.lane}`, s] as const),
  );

  return buildSeeds(meetId, eventId, entrants, laneCount).map((seed) => {
    const before = existing.get(`${seed.heat}/${seed.lane}`);
    return before && before.athleteId === seed.athleteId
      ? { ...seed, id: before.id, seedTimeMs: before.seedTimeMs }
      : seed;
  });
}

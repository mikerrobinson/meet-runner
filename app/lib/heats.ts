import { generateId } from "./id";
import type { Heat, LaneCount, MeetDoc } from "~/types/meet";

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
 * Heats are numbered in swum order, and any short heat comes first — that's
 * how meets actually run it, so the last heat is full. Within a heat, swimmers
 * fill lanes from the middle outward.
 */
export function buildHeats(
  eventId: string,
  athleteIds: string[],
  laneCount: LaneCount,
): Heat[] {
  if (athleteIds.length === 0) return [];

  const order = laneOrder(laneCount);
  const heatCount = Math.ceil(athleteIds.length / laneCount);
  const remainder = athleteIds.length % laneCount;
  const firstHeatSize = remainder === 0 ? laneCount : remainder;

  const heats: Heat[] = [];
  let cursor = 0;

  for (let index = 0; index < heatCount; index++) {
    const size = index === 0 ? firstHeatSize : laneCount;
    const group = athleteIds.slice(cursor, cursor + size);
    cursor += size;

    const lanes: (string | null)[] = new Array(laneCount).fill(null);
    group.forEach((athleteId, i) => {
      lanes[order[i] - 1] = athleteId;
    });

    heats.push({ id: generateId(), eventId, index, lanes });
  }

  return heats;
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

export function heatsForEvent(meet: MeetDoc, eventId: string): Heat[] {
  return meet.heats
    .filter((h) => h.eventId === eventId)
    .sort((a, b) => a.index - b.index);
}

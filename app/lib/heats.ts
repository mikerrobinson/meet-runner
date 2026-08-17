import { generateId } from "./id";
import type { Heat, LaneCount, MeetDoc } from "~/types/meet";

/**
 * Lane assignment order, fastest lane first. Standard practice puts the top
 * seed in the middle of the pool and works outward, alternating sides.
 */
const LANE_ORDER: Record<LaneCount, number[]> = {
  4: [2, 3, 1, 4],
  6: [3, 4, 2, 5, 1, 6],
  8: [4, 5, 3, 6, 2, 7, 1, 8],
};

export function laneOrder(laneCount: LaneCount): number[] {
  return LANE_ORDER[laneCount] ?? LANE_ORDER[6];
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
  swimmerIds: string[],
  laneCount: LaneCount,
): Heat[] {
  if (swimmerIds.length === 0) return [];

  const order = laneOrder(laneCount);
  const heatCount = Math.ceil(swimmerIds.length / laneCount);
  const remainder = swimmerIds.length % laneCount;
  const firstHeatSize = remainder === 0 ? laneCount : remainder;

  const heats: Heat[] = [];
  let cursor = 0;

  for (let index = 0; index < heatCount; index++) {
    const size = index === 0 ? firstHeatSize : laneCount;
    const group = swimmerIds.slice(cursor, cursor + size);
    cursor += size;

    const lanes: (string | null)[] = new Array(laneCount).fill(null);
    group.forEach((swimmerId, i) => {
      lanes[order[i] - 1] = swimmerId;
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

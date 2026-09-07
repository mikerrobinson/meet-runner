/**
 * The timer's side of the deck.
 *
 * Everything a timing phone holds lives in localStorage: the grant it scanned,
 * which lane it's standing behind, where it has got to in the running order,
 * and — the important one — any times it hasn't managed to send yet.
 *
 * There is no IndexedDB and no sync engine here, on purpose. This device reads
 * one small document and posts times back. What it must never do is lose a
 * time because the pool wifi dropped, which is what the queue is for.
 */

import { apiUrl, ApiError } from "./http";
import { generateId } from "./id";
import type { Athlete, Entries, Heat, MeetEvent, WatchTime } from "~/types/meet";

const GRANT_KEY = "meet-runner:timer-grant";
const LANE_KEY = "meet-runner:timer-lane";
const QUEUE_KEY = "meet-runner:timer-queue";
const POSITION_KEY = "meet-runner:timer-position";

/* ------------------------------------------------------------------ grant */

export function loadGrant(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(GRANT_KEY) ?? "";
}

export function saveGrant(token: string): void {
  if (typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(GRANT_KEY, token);
  else localStorage.removeItem(GRANT_KEY);
}

/**
 * A new grant is a new meet, so the position and the chosen lane go with it.
 * Otherwise a phone used at last week's meet would open this one already
 * eleven heats in.
 */
export function adoptGrant(token: string): void {
  if (typeof localStorage === "undefined") return;
  if (loadGrant() !== token) {
    localStorage.removeItem(POSITION_KEY);
    localStorage.removeItem(LANE_KEY);
  }
  saveGrant(token);
}

export function loadLane(): number | null {
  if (typeof localStorage === "undefined") return null;
  const stored = Number(localStorage.getItem(LANE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function saveLane(lane: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LANE_KEY, String(lane));
}

/** Step back to the lane question — a timer swapping ends of the pool. */
export function clearLane(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LANE_KEY);
}

/* ------------------------------------------------------- the running order */

/** One heat, flattened into the order the meet is actually swum in. */
export interface Stop {
  event: MeetEvent;
  heat: Heat;
  /** 1-based, for "Heat 2 of 4". */
  number: number;
  of: number;
}

/**
 * Every heat in the order they'll be swum.
 *
 * The timer moves through this one step at a time. Events with no heats seeded
 * are skipped rather than shown empty — there is nothing to time, and a screen
 * offering a stopwatch for a heat that doesn't exist is a screen that gets a
 * time recorded against nothing.
 */
export function runningOrder(events: MeetEvent[], heats: Heat[]): Stop[] {
  const order: Stop[] = [];
  for (const event of events) {
    const forEvent = heats
      .filter((heat) => heat.eventId === event.id)
      .sort((a, b) => a.index - b.index);
    forEvent.forEach((heat, index) => {
      order.push({ event, heat, number: index + 1, of: forEvent.length });
    });
  }
  return order;
}

export interface Position {
  /** Where they are now, as an index into the running order. */
  at: number;
  /** The furthest heat they've submitted a time for. */
  submitted: number;
}

export function loadPosition(): Position {
  if (typeof localStorage === "undefined") return { at: 0, submitted: -1 };
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "");
    return {
      at: Number(stored?.at) || 0,
      submitted: Number.isFinite(stored?.submitted) ? stored.submitted : -1,
    };
  } catch {
    return { at: 0, submitted: -1 };
  }
}

export function savePosition(position: Position): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(POSITION_KEY, JSON.stringify(position));
}

/**
 * The earliest heat a timer may go back to.
 *
 * One heat behind whatever they last submitted, and no further. The reason is
 * the one thing timers can't do on paper either: once a runner has collected
 * the sheet and a result has been reconciled, the facts underneath it must not
 * quietly change. Correcting the time you just took is fair; rewriting an
 * event that's been announced is not.
 */
export function earliestAllowed(position: Position): number {
  return Math.max(0, position.submitted - 1);
}

/* ------------------------------------------------------------------ queue */

/**
 * A person a timer typed in, and the team they said it was.
 *
 * The team travels as an id rather than a name because the server turns it
 * into a roster entry, and it will only do that for a team actually racing
 * this meet — a name would have to be matched back to one, which is exactly
 * the guessing the old string label forced.
 */
export interface QueuedAthlete extends Athlete {
  teamId?: string;
}

export interface QueuedWrite {
  watches: WatchTime[];
  athletes: QueuedAthlete[];
}

function readQueue(): QueuedWrite {
  if (typeof localStorage === "undefined") return { watches: [], athletes: [] };
  try {
    const stored = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "");
    return {
      watches: Array.isArray(stored?.watches) ? stored.watches : [],
      athletes: Array.isArray(stored?.athletes) ? stored.athletes : [],
    };
  } catch {
    return { watches: [], athletes: [] };
  }
}

function writeQueue(queue: QueuedWrite): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function queueSize(): number {
  const queue = readQueue();
  return queue.watches.length + queue.athletes.length;
}

/**
 * Add to the outbox, replacing anything for the same watch.
 *
 * Keyed by watch id, so a timer who corrects a time before it manages to send
 * queues one time rather than two contradictory ones.
 */
export function enqueue(write: Partial<QueuedWrite>): void {
  const queue = readQueue();
  for (const watch of write.watches ?? []) {
    const at = queue.watches.findIndex((existing) => existing.id === watch.id);
    if (at >= 0) queue.watches[at] = watch;
    else queue.watches.push(watch);
  }
  for (const athlete of write.athletes ?? []) {
    if (!queue.athletes.some((existing) => existing.id === athlete.id)) {
      queue.athletes.push(athlete);
    }
  }
  writeQueue(queue);
}

/**
 * Try to send everything waiting.
 *
 * The queue is only cleared once the server has actually taken it. A failure
 * leaves it exactly as it was, so the next attempt — a tap, the next
 * submission, or coming back into signal — sends the same times again. Watches
 * are keyed by heat, lane and timer, so sending twice is not two times.
 */
export async function flush(): Promise<{ sent: number; error?: string }> {
  const queue = readQueue();
  const waiting = queue.watches.length + queue.athletes.length;
  if (waiting === 0) return { sent: 0 };

  try {
    await timerPost("/api/timer/watch", queue);
    writeQueue({ watches: [], athletes: [] });
    return { sent: waiting };
  } catch (error) {
    return {
      sent: 0,
      error: error instanceof Error ? error.message : "Couldn't send",
    };
  }
}

/* ------------------------------------------------------------------ wire */

/** The grant is the whole credential; there's no session behind it. */
async function timerFetch(path: string, init?: RequestInit): Promise<unknown> {
  const grant = loadGrant();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(grant ? { authorization: `Bearer ${grant}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("No signal", 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (body as { error?: string } | null)?.error ?? `Failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

function timerPost(path: string, body: unknown): Promise<unknown> {
  return timerFetch(path, { method: "POST", body: JSON.stringify(body) });
}

export interface TimerAthlete {
  id: string;
  firstName: string;
  lastName: string;
  /** Display label for whichever team enrolled them. */
  team?: string;
}

export interface TimerTeam {
  id: string;
  name: string;
}

export interface Snapshot {
  serverTime: number;
  expiresAt: number;
  meet: {
    id: string;
    name: string;
    date: string;
    laneCount: number;
    teams: TimerTeam[];
  };
  /** What to call athletes with no team label of their own. */
  ownTeam: string;
  events: MeetEvent[];
  heats: Heat[];
  entries: Entries;
  athletes: TimerAthlete[];
  mine: WatchTime[];
}

export function fetchSnapshot(timerId: string): Promise<Snapshot> {
  return timerFetch(
    `/api/timer/meet?timerId=${encodeURIComponent(timerId)}`,
  ) as Promise<Snapshot>;
}

/**
 * A swimmer a timer typed in, minted on the device.
 *
 * The id is generated here rather than asked of the server so that adding
 * someone works with no signal at all — the person and the time they were
 * given then travel together in the queue.
 */
export function newVisitingAthlete(
  name: string,
  teamId: string,
  gender: Athlete["gender"],
): QueuedAthlete {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const cut = trimmed.lastIndexOf(" ");
  return {
    id: generateId(),
    firstName: cut > 0 ? trimmed.slice(0, cut) : trimmed,
    lastName: cut > 0 ? trimmed.slice(cut + 1) : "",
    gender,
    teamId: teamId || undefined,
  };
}

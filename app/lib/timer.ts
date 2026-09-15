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

import { apiUrl, ApiError, appBasePath } from "./http";
import { A_WEEK, readCookie } from "./cookies";
import { splitTypedName } from "./timer-messages";
import { local } from "./local";
import { generateId } from "./id";
import type { Athlete, Heat, MeetEvent, Watch } from "~/types/meet";

/**
 * How far this phone has got, and nothing else.
 *
 * Which lane, which event, which heat and which meet all used to be cookies.
 * They are in the URL now — every timing page is
 * `/meets/{meetId}/timers/{timerId}/{event}/{heat}/{lane}` — so the address
 * bar is the only record of where a timer is standing, the back button works,
 * and a reloaded phone comes back exactly where it was without having
 * remembered anything.
 *
 * What the URL can't say is how far somebody has *been*, which is what stops
 * them wandering back into a heat whose sheet has already gone to the desk.
 * One number, scoped by its own path to this meet and this device, so a
 * different meet starts clean without anything having to notice.
 */
const FURTHEST_COOKIE = "mr_timer_done";

function furthestPath(meetId: string, timerId: string): string {
  return (
    `${appBasePath()}meets/${encodeURIComponent(meetId)}` +
    `/timers/${encodeURIComponent(timerId)}`
  );
}

/** The furthest heat submitted, as an index into the running order. */
export function loadFurthest(meetId: string, timerId: string): number {
  const raw = readCookie(FURTHEST_COOKIE);
  const value = Number(raw);
  return raw !== null && Number.isInteger(value) && value >= 0 ? value : -1;
}

export function saveFurthest(
  meetId: string,
  timerId: string,
  index: number,
): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${FURTHEST_COOKIE}=${index}` +
    `; Path=${furthestPath(meetId, timerId)}; SameSite=Lax` +
    `; Max-Age=${A_WEEK}${secure}`;
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

/**
 * Throw away the token the build before last kept in localStorage.
 *
 * Grants live in an HttpOnly cookie now, so a copy sitting in storage is a
 * working credential that nothing reads and any script on the page could —
 * the exact thing moving to a cookie was meant to stop. Phones that timed a
 * meet on the old build still have one until they are told otherwise, and it
 * can go once none do.
 */
export function forgetLegacyGrant(): void {
  local.remove("meet-runner:timer-grant");
}

/* ------------------------------------------------------------------ queue */

/**
 * The queue moved out, into cookies — see `timer-queue.ts`.
 *
 * It used to live in localStorage here, which every other device in this app
 * can rely on and a timer's phone cannot: the browser a camera app opens may
 * be a private window or a webview with site storage switched off. What is
 * left in this file is the snapshot and the running order, which are read
 * from the server on every poll and so need keeping nowhere.
 */

/* ------------------------------------------------------------------ wire */

/**
 * The grant is the whole credential, and the browser carries it.
 *
 * Nothing is attached here: the cookie `/t/:token` set rides every same-origin
 * request by itself. There is no token in this file to attach, which is the
 * point — a credential no script can read is one no script can leak.
 */
async function timerFetch(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
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
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  athletes: TimerAthlete[];
  mine: Watch[];
}

export function fetchSnapshot(timerId: string): Promise<Snapshot> {
  return timerFetch(
    `/api/timer/meet?timerId=${encodeURIComponent(timerId)}`,
  ) as Promise<Snapshot>;
}

/**
 * The earliest heat a timer may go back to.
 *
 * One behind whatever they last submitted, and no further. The reason is the
 * one thing timers can't do on paper either: once a runner has collected the
 * sheet and a result has been reconciled, the facts underneath it must not
 * quietly change. Correcting the time you just took is fair; rewriting an
 * event that has been announced is not.
 *
 * Takes the furthest heat reached rather than a position, now that where a
 * timer *is* comes from the URL and only where they have *been* is remembered.
 */
export function earliestAllowed(furthest: number): number {
  return Math.max(0, furthest - 1);
}

/**
 * A person a timer typed in.
 *
 * Carries the team the timer tapped, because a visiting swimmer belongs to a
 * real roster and guessing which one is how a season ends up with two Sofias.
 */
export interface QueuedAthlete extends Athlete {
  teamId?: string;
}

/**
 * A swimmer a timer typed in, for the screen to show immediately.
 *
 * The id minted here is local and temporary. The `seat` message carries the
 * *name*, and the server mints the id that lasts — it is the only side that
 * can tell a genuinely new person from one it already has, which a phone
 * holding a partial roster cannot. The next snapshot replaces this one, so
 * nothing is allowed to key off it.
 */
export function newVisitingAthlete(
  name: string,
  teamId: string,
  gender: Athlete["gender"],
): QueuedAthlete {
  // The same split the server will apply to the name in the `seat` message,
  // so the lane doesn't show one thing now and another after the next poll.
  return {
    id: generateId(),
    ...splitTypedName(name),
    gender,
    teamId: teamId || undefined,
  };
}

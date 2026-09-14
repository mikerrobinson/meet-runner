/**
 * Writes that survive a bad moment on pool wifi.
 *
 * Every change a deck screen makes goes in here first: a tick on the
 * registration grid, a swimmer moved into a lane, a time off a stopwatch, a
 * lane signed off at the desk. The queue is drained in order, and it is held
 * in localStorage, so the tab can be reloaded — or the phone locked and picked
 * up again — without losing a time somebody actually took.
 *
 * This is the whole of what's left of "offline". The server is the source of
 * truth and screens read from loaders; the only thing the device keeps is what
 * it has said and not yet been acknowledged for.
 *
 * **A failure that can't be fixed by waiting is not retried.** The engine this
 * replaced backed off and tried again on every error including a 400, so one
 * write the server would never accept sat in front of everything else,
 * forever, behind a chip that said "Retrying…". Here, a 4xx that isn't a
 * timeout or a rate limit is dropped and reported; only network failures and
 * 5xx are worth another go.
 */

import { apiUrl } from "./http";
import { generateId } from "./id";
import { loadSessionToken } from "./storage";
import type { ResultStatus } from "~/types/meet";

/**
 * One thing somebody did.
 *
 * A closed union rather than a free-form request, because the queue has to be
 * replayable from storage a reload later and understandable by the pending
 * overlay — both of which need to know what a write *means*, not just where it
 * was going.
 */
export type Write =
  | { kind: "entry"; meetId: string; eventId: string; athleteId: string; entering: boolean }
  | { kind: "seat"; meetId: string; heatId: string; lane: number; athleteId: string }
  | { kind: "unseat"; meetId: string; heatId: string; lane: number }
  | {
      kind: "watch";
      meetId: string;
      heatId: string;
      lane: number;
      timerId: string;
      timeMs: number;
      source: "stopwatch" | "typed";
      recordedAt: number;
      startedAt?: number;
      stoppedAt?: number;
    }
  | { kind: "clear-watches"; meetId: string; heatId: string; timerId: string }
  | { kind: "drop-watch"; meetId: string; heatId: string; lane: number; timerId: string }
  | {
      kind: "call";
      meetId: string;
      heatId: string;
      lane: number;
      status?: ResultStatus;
      timeMs?: number | null;
      athleteId?: string | null;
      final?: boolean;
    }
  | { kind: "uncall"; meetId: string; heatId: string; lane: number };

export interface Queued {
  id: string;
  write: Write;
  queuedAt: number;
  /** How many times sending has failed for a reason worth retrying. */
  tries: number;
}

export interface OutboxState {
  pending: Queued[];
  /** Set when a write was refused for good. Cleared by the next success. */
  error: string | null;
  sending: boolean;
}

const KEY = "meet-runner:outbox";

/* ----------------------------------------------------------------- storage */

function read(): Queued[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as Queued[]) : [];
  } catch {
    return [];
  }
}

function write(queue: Queued[]): void {
  if (typeof localStorage === "undefined") return;
  if (queue.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(queue));
}

/* --------------------------------------------------------------- the queue */

let state: OutboxState = { pending: read(), error: null, sending: false };
const listeners = new Set<(state: OutboxState) => void>();

function publish(next: Partial<OutboxState>): void {
  state = { ...state, ...next };
  write(state.pending);
  for (const listener of listeners) listener(state);
}

export function subscribe(listener: (state: OutboxState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshot(): OutboxState {
  return state;
}

/**
 * Add a write, replacing one it supersedes.
 *
 * Changing your mind twice before anything reaches the server is one answer,
 * not two: a lane seated and reseated, a tick toggled on and off, a time taken
 * and retaken. `supersedes` decides what counts as the same decision, and it
 * is deliberately per-kind — two timers' watches on one lane are different
 * writes, the same timer's two watches on one lane are not.
 */
export function enqueue(item: Write): void {
  const queued: Queued = {
    id: generateId(),
    write: item,
    queuedAt: Date.now(),
    tries: 0,
  };
  const pending = state.pending.filter((q) => !supersedes(item, q.write));
  publish({ pending: [...pending, queued] });
  void flush();
}

function supersedes(next: Write, old: Write): boolean {
  if (next.meetId !== old.meetId) return false;
  switch (next.kind) {
    case "entry":
      return (
        (old.kind === "entry") &&
        old.eventId === next.eventId &&
        old.athleteId === next.athleteId
      );
    case "seat":
    case "unseat":
      return (
        (old.kind === "seat" || old.kind === "unseat") &&
        old.heatId === next.heatId &&
        old.lane === next.lane
      );
    case "watch":
    case "drop-watch":
      return (
        (old.kind === "watch" || old.kind === "drop-watch") &&
        old.heatId === next.heatId &&
        old.lane === next.lane &&
        old.timerId === next.timerId
      );
    case "call":
    case "uncall":
      return (
        (old.kind === "call" || old.kind === "uncall") &&
        old.heatId === next.heatId &&
        old.lane === next.lane
      );
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ sending */

interface Endpoint {
  url: string;
  method: string;
  body?: unknown;
}

/** Where a write goes, and what it says when it gets there. */
function endpointFor(item: Write): Endpoint {
  const base = `/api/meets/${encodeURIComponent(item.meetId)}`;
  switch (item.kind) {
    case "entry":
      return {
        url: `${base}/entries`,
        method: item.entering ? "POST" : "DELETE",
        body: { eventId: item.eventId, athleteId: item.athleteId },
      };
    case "seat":
      return {
        url: `${base}/seats`,
        method: "POST",
        body: { heatId: item.heatId, lane: item.lane, athleteId: item.athleteId },
      };
    case "unseat":
      return {
        url: `${base}/seats`,
        method: "DELETE",
        body: { heatId: item.heatId, lane: item.lane },
      };
    case "watch":
      return { url: `${base}/watches`, method: "POST", body: item };
    case "drop-watch":
      return {
        url: `${base}/watches`,
        method: "DELETE",
        body: { heatId: item.heatId, lane: item.lane, timerId: item.timerId },
      };
    case "clear-watches":
      return {
        url: `${base}/watches`,
        method: "DELETE",
        body: { heatId: item.heatId, timerId: item.timerId },
      };
    case "call":
      return { url: `${base}/calls`, method: "POST", body: item };
    case "uncall":
      return {
        url: `${base}/calls`,
        method: "DELETE",
        body: { heatId: item.heatId, lane: item.lane },
      };
  }
}

/**
 * Whether it is worth trying again.
 *
 * Nothing the server has already understood and refused gets a second go. A
 * 403 is not going to become a 200 because we waited, and a queue that retries
 * one anyway blocks every write behind it.
 */
function worthRetrying(status: number): boolean {
  if (status === 0) return true; // no network
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const BACKOFF_MS = [1000, 3000, 8000, 20_000, 60_000];

/**
 * Send what's waiting, oldest first, stopping at the first thing that can't go
 * yet.
 *
 * In order and one at a time on purpose: a seat and the watch that follows it
 * describe the same lane, and letting the second overtake the first would put
 * a time against whoever used to be there.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  if (state.pending.length === 0) return;
  flushing = true;
  publish({ sending: true });

  try {
    while (state.pending.length > 0) {
      const head = state.pending[0];
      const { url, method, body } = endpointFor(head.write);

      let status = 0;
      let message = "No signal";
      try {
        const token = loadSessionToken();
        const response = await fetch(apiUrl(url), {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = response.status;
        if (!response.ok) {
          const parsed = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          message = parsed?.error ?? `Failed (${status})`;
        }
      } catch {
        status = 0;
      }

      if (status !== 0 && status < 400) {
        publish({ pending: state.pending.slice(1), error: null });
        continue;
      }

      if (worthRetrying(status)) {
        const tries = head.tries + 1;
        publish({
          pending: [{ ...head, tries }, ...state.pending.slice(1)],
        });
        schedule(BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)]);
        return;
      }

      // Refused for good. Drop it so the rest of the queue can move, and say
      // so — silently discarding somebody's time would be worse than either.
      publish({ pending: state.pending.slice(1), error: message });
    }
  } finally {
    flushing = false;
    publish({ sending: false });
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

/** Coming back into signal, or back to the tab, is the moment to try again. */
export function startOutbox(): () => void {
  const retry = () => void flush();
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  const tick = setInterval(retry, 20_000);
  void flush();
  return () => {
    window.removeEventListener("online", retry);
    document.removeEventListener("visibilitychange", retry);
    clearInterval(tick);
    if (timer) clearTimeout(timer);
  };
}

export function dismissError(): void {
  publish({ error: null });
}

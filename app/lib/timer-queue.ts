/**
 * The timing phone's outbox, kept entirely in cookies.
 *
 * Every other device in this app queues in localStorage. A timer can't: the
 * phone belongs to a parent who volunteered ten minutes ago, opened from a
 * camera app into whatever browser it chose, which may be a private window or
 * a locked-down webview with site storage switched off. Cookies are what such
 * a browser still keeps, so cookies are what timing uses.
 *
 * Two halves, and they do different jobs:
 *
 * - **The payloads** are cookies scoped to the URL that consumes them. The
 *   browser attaches them to the next request to that lane and the server
 *   deletes them on the way out, so nothing here walks a list of bodies. They
 *   are not readable from this page — a cookie is only visible to a document
 *   whose path it matches — and they don't need to be.
 * - **The index** is one readable cookie naming which lanes still owe
 *   something. It is the only part this file reads back, it holds no data
 *   beyond `event/heat/lane`, and it is what makes replay possible after a
 *   reload: without it the payloads would sit there, correctly addressed and
 *   permanently unsent, because nothing would know to make the request.
 */

import { A_WEEK, readCookie, writeCookie } from "./cookies";
import { appBasePath } from "./http";
import {
  formatSeat,
  formatStart,
  formatStop,
  formatSubmit,
  laneKey,
  parseLaneKey,
  type LaneRef,
} from "./timer-messages";

/** Which lanes have something outstanding. Readable; tiny; ours. */
const INDEX_COOKIE = "mr_timer_q";

/**
 * When a message is too big to store.
 *
 * A browser handed a cookie over about 4KB does not complain — it drops the
 * write. So the check has to happen here, before the value is handed over,
 * and the answer has to reach the screen. Deliberately well under the limit:
 * the path counts toward it too, and being approximately right about the
 * ceiling is worth more than being exactly right about it.
 */
const MAX_VALUE = 3000;

/**
 * How many lanes may be outstanding before this stops being a blip.
 *
 * Browsers cap cookies per domain — around 150 in Firefox, 180 in Chrome —
 * and four actions a lane means that arrives sooner than the byte limit does.
 * Long before either, a timer with thirty unsent lanes has a problem that
 * wants solving on the deck rather than by the app.
 */
const MAX_PENDING = 30;

export interface QueueState {
  /** Lanes with something still to send. */
  pending: LaneRef[];
  /** Set when something could not be stored at all. Needs a person. */
  overflow: boolean;
}

let overflow = false;

/* ------------------------------------------------------------------ paths */

/**
 * The URL a lane's messages belong to, which is also the cookie path that
 * gets them there. One string, used as both, so they cannot drift apart —
 * a cookie whose path is a character off the request path is simply never
 * sent, and nothing anywhere would say so.
 */
export function lanePath(meetId: string, timerId: string, at: LaneRef): string {
  return (
    `${appBasePath()}api/meets/${encodeURIComponent(meetId)}` +
    `/timers/${encodeURIComponent(timerId)}` +
    `/${at.event}/${at.heat}/${at.lane}`
  );
}

/* ------------------------------------------------------------------ index */

function readIndex(): LaneRef[] {
  const raw = readCookie(INDEX_COOKIE) ?? "";
  return raw
    .split("|")
    .map(parseLaneKey)
    .filter((ref): ref is LaneRef => ref !== null);
}

function writeIndex(refs: LaneRef[]): void {
  const value = refs.map(laneKey).join("|");
  if (value.length > MAX_VALUE) {
    overflow = true;
    return;
  }
  writeCookie(INDEX_COOKIE, value, A_WEEK);
}

function remember(at: LaneRef): void {
  const refs = readIndex();
  if (refs.some((ref) => laneKey(ref) === laneKey(at))) return;
  if (refs.length >= MAX_PENDING) overflow = true;
  writeIndex([...refs, at]);
}

function forget(at: LaneRef): void {
  writeIndex(readIndex().filter((ref) => laneKey(ref) !== laneKey(at)));
}

export function queueState(): QueueState {
  return { pending: readIndex(), overflow };
}

export function clearOverflow(): void {
  overflow = false;
}

/* --------------------------------------------------------------- enqueuing */

/**
 * Write one message, addressed to the lane it happened on.
 *
 * Setting the same action on the same lane again overwrites it, which is the
 * behaviour we want and costs nothing to get: a timer who corrects a time and
 * submits again has said one thing, not two. The browser's own idea of cookie
 * identity — name, domain and path — is exactly the key the server writes by.
 */
function put(
  meetId: string,
  timerId: string,
  at: LaneRef,
  action: string,
  value: string,
): void {
  if (typeof document === "undefined") return;
  const path = lanePath(meetId, timerId, at);

  if (encodeURIComponent(value).length > MAX_VALUE) {
    // Nothing sensible to truncate — half a time is not a time.
    overflow = true;
    return;
  }

  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${action}=${encodeURIComponent(value)}` +
    `; Path=${path}; SameSite=Lax; Max-Age=${A_WEEK}${secure}`;

  remember(at);
}

export function enqueueSeat(
  meetId: string,
  timerId: string,
  at: LaneRef,
  seat: { team: number; athleteId?: string; name?: string },
): void {
  put(meetId, timerId, at, "seat", formatSeat({
    at: Date.now(),
    team: seat.team,
    athleteId: seat.athleteId ?? "",
    name: seat.name ?? "",
  }));
}

export function enqueueStart(
  meetId: string,
  timerId: string,
  at: LaneRef,
  startedAt: number,
): void {
  put(meetId, timerId, at, "start", formatStart({ at: Date.now(), startedAt }));
}

export function enqueueStop(
  meetId: string,
  timerId: string,
  at: LaneRef,
  stoppedAt: number,
): void {
  put(meetId, timerId, at, "stop", formatStop({ at: Date.now(), stoppedAt }));
}

export function enqueueSubmit(
  meetId: string,
  timerId: string,
  at: LaneRef,
  elapsedMs: number,
): void {
  put(meetId, timerId, at, "submit", formatSubmit({ at: Date.now(), elapsedMs }));
}

/* ---------------------------------------------------------------- sending */

/**
 * Post every lane that owes something.
 *
 * The request carries no body. Everything it has to say is already attached
 * to it, by the browser, because the cookies' path matches the URL — so this
 * is a list of addresses rather than a list of payloads, and a lane drops off
 * the list only once the server has answered for it.
 *
 * A failure leaves both the payload cookies and the index entry exactly as
 * they were. Sending the same lane twice writes the same rows twice, which is
 * the same as writing them once.
 */
export async function flushQueue(
  meetId: string,
  timerId: string,
): Promise<{ sent: number; error?: string }> {
  const pending = readIndex();
  if (pending.length === 0) return { sent: 0 };

  let sent = 0;
  let error: string | undefined;

  for (const at of pending) {
    try {
      const response = await fetch(lanePath(meetId, timerId, at), {
        method: "POST",
        // Same-origin, so the cookies ride along without being asked.
        credentials: "same-origin",
      });

      if (response.ok) {
        forget(at);
        sent += 1;
        continue;
      }

      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      error = body?.error ?? `Failed (${response.status})`;

      // A refusal the server has already understood will not become an
      // acceptance by waiting — and unlike a dropped connection, it means
      // this lane will block every one behind it forever. Drop it, and say so.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        forget(at);
      }
      break;
    } catch {
      error = "No signal";
      break;
    }
  }

  return { sent, error };
}

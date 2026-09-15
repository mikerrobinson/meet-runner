/**
 * Device-local preferences. The meet and team documents live in IndexedDB
 * (see `db.ts`); everything here is deliberately per-device and is never
 * synced or exported.
 */

import { A_YEAR, readCookie, writeCookie } from "./cookies";
import { local } from "./local";
import {
  LANE_LAYOUTS,
  type LaneLayout,
  type NameOrder,
  type Progress,
} from "~/types/meet";

const AUTO_SYNC_KEY = "meet-runner:auto-sync";
const TOKEN_KEY = "meet-runner:sync-token";
const SESSION_KEY = "meet-runner:session";
const LANE_LAYOUT_KEY = "meet-runner:lane-layout";
const TIMER_ID_KEY = "meet-runner:timer-id";
/**
 * Who this device is when it takes a time, in a cookie.
 *
 * The one piece of device state whose loss corrupts data rather than costing
 * a tap: watches are keyed by it, so a device that forgets its id and mints a
 * new one files a second watch on a lane it already timed, and the proposed
 * time moves. Cookies hold where localStorage is refused, which on a timer's
 * borrowed phone is often enough to matter.
 */
const TIMER_ID_COOKIE = "mr_timer_id";
const PROGRESS_PREFIX = "meet-runner:progress:";

/**
 * Whether this device pushes on its own. A device/network preference rather
 * than a property of the meet, so it lives outside the document — otherwise
 * switching it off here would switch it off on every other device too, and
 * the change itself would trigger one last push to say so.
 */
export function loadAutoSync(): boolean {
  return local.get(AUTO_SYNC_KEY) !== "off";
}

export function saveAutoSync(enabled: boolean): void {
  local.set(AUTO_SYNC_KEY, enabled ? "on" : "off");
}

/** The sync token lives outside the meet doc so it never lands in an export. */
export function loadSyncToken(): string {
  return local.get(TOKEN_KEY) ?? "";
}

export function saveSyncToken(token: string): void {
  if (token) local.set(TOKEN_KEY, token);
  else local.remove(TOKEN_KEY);
}

/**
 * Proof of who is signed in on this device.
 *
 * Kept alongside the other device preferences rather than in a cookie: every
 * call the app makes is a `fetch` it controls, so a header is simpler than a
 * cookie and can't be sent by anything else — which is the whole of CSRF gone
 * rather than defended against.
 *
 * It survives a reload and a closed lid on purpose. A coach signs in once on
 * the iPad in the swim bag; being asked again at the start of a meet, on pool
 * wifi, is the failure this exists to avoid.
 */
export function loadSessionToken(): string {
  return local.get(SESSION_KEY) ?? "";
}

export function saveSessionToken(token: string): void {
  if (token) local.set(SESSION_KEY, token);
  else local.remove(SESSION_KEY);
}

/**
 * How the stopwatch arranges its lane buttons. A property of whoever is
 * holding the device — where they stand on the deck, which hand they use —
 * rather than of the meet, so it stays here and carries to the next meet
 * instead of being set again on every one.
 */
export function loadLaneLayout(): LaneLayout {
  const stored = local.get(LANE_LAYOUT_KEY) as LaneLayout | null;
  return stored && LANE_LAYOUTS.includes(stored) ? stored : "grid";
}

export function saveLaneLayout(layout: LaneLayout): void {
  local.set(LANE_LAYOUT_KEY, layout);
}

const NAME_ORDER_KEY = "meet-runner:name-order";

/**
 * How this person likes names written and sorted.
 *
 * Moved off the team document, where it used to live. That was defensible
 * while a team was one coach's private season; now that teams are shared and
 * publicly readable, a visiting coach flipping it would have changed how the
 * home team reads its own roster. A display preference belongs to whoever is
 * looking, not to the thing being looked at.
 */
export function loadNameOrder(): NameOrder {
  return local.get(NAME_ORDER_KEY) === "first" ? "first" : "last";
}

export function saveNameOrder(order: NameOrder): void {
  local.set(NAME_ORDER_KEY, order);
}

/**
 * Who this device is when it takes a time.
 *
 * A lane can be timed by several people at once, and each watch is stored
 * under whoever took it — so "this device" needs a name that survives a
 * reload, or every reload would look like a new timer and pile up duplicate
 * times on the same lane. Becomes a user id once there are accounts.
 */
export function loadTimerId(): string {
  if (typeof document === "undefined") return "device";
  // Whatever this page already decided. Two calls on one page must never
  // disagree, whatever the browser will or won't keep for us — that is the
  // difference between one watch on a lane and two.
  if (session) return session;

  // The cookie first, then the key phones that timed on the build before this
  // one still hold. Carrying the old id across rather than minting a fresh one
  // is what stops such a device filing a second watch on a lane it has already
  // timed — and the id it keeps is written to the cookie below, so this is the
  // last time it needs asking.
  const stored = readCookie(TIMER_ID_COOKIE) ?? local.get(TIMER_ID_KEY);

  session = stored || `d-${Math.random().toString(36).slice(2, 10)}`;
  writeCookie(TIMER_ID_COOKIE, session, A_YEAR);
  return session;
}

/**
 * This page's answer, held in the module.
 *
 * The identity has to be stable for as long as the tab is open even when
 * nothing at all can be persisted — a browser that keeps neither cookies nor
 * localStorage would otherwise mint a fresh id on every call, and every watch
 * this device sent would look like it came from a different timer. Several
 * watches on one lane are averaged, so that doesn't just duplicate a time, it
 * changes the one the desk reads.
 */
let session: string | null = null;

/**
 * Where this device has got to in a meet's running order.
 *
 * It used to live in the meet document, excluded from sync by hand and then
 * patched back in on every pull — a field inside the document that was not
 * part of it. It is device state and always was: three people work one meet
 * from three places in the programme, and an administrator signing off event
 * 4 while the deck swims event 6 is the normal case rather than a conflict.
 *
 * Keyed by meet, because "where I am" means nothing without one. A stale key
 * for last season's meet costs a few bytes and answers correctly if that meet
 * is ever opened again.
 */
export function loadProgress(meetId: string): Progress {
  try {
    const stored = JSON.parse(local.get(PROGRESS_PREFIX + meetId) ?? "");
    return {
      eventIndex: Number(stored?.eventIndex) || 0,
      heatIndex: Number(stored?.heatIndex) || 0,
    };
  } catch {
    return { eventIndex: 0, heatIndex: 0 };
  }
}

export function saveProgress(meetId: string, progress: Progress): void {
  local.set(PROGRESS_PREFIX + meetId, JSON.stringify(progress));
}

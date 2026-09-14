/**
 * Device-local preferences. The meet and team documents live in IndexedDB
 * (see `db.ts`); everything here is deliberately per-device and is never
 * synced or exported.
 */

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
const PROGRESS_PREFIX = "meet-runner:progress:";

/**
 * Whether this device pushes on its own. A device/network preference rather
 * than a property of the meet, so it lives outside the document — otherwise
 * switching it off here would switch it off on every other device too, and
 * the change itself would trigger one last push to say so.
 */
export function loadAutoSync(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(AUTO_SYNC_KEY) !== "off";
}

export function saveAutoSync(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTO_SYNC_KEY, enabled ? "on" : "off");
}

/** The sync token lives outside the meet doc so it never lands in an export. */
export function loadSyncToken(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveSyncToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(SESSION_KEY) ?? "";
}

export function saveSessionToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(SESSION_KEY, token);
  else localStorage.removeItem(SESSION_KEY);
}

/**
 * How the stopwatch arranges its lane buttons. A property of whoever is
 * holding the device — where they stand on the deck, which hand they use —
 * rather than of the meet, so it stays here and carries to the next meet
 * instead of being set again on every one.
 */
export function loadLaneLayout(): LaneLayout {
  if (typeof localStorage === "undefined") return "grid";
  const stored = localStorage.getItem(LANE_LAYOUT_KEY) as LaneLayout | null;
  return stored && LANE_LAYOUTS.includes(stored) ? stored : "grid";
}

export function saveLaneLayout(layout: LaneLayout): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LANE_LAYOUT_KEY, layout);
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
  if (typeof localStorage === "undefined") return "last";
  return localStorage.getItem(NAME_ORDER_KEY) === "first" ? "first" : "last";
}

export function saveNameOrder(order: NameOrder): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(NAME_ORDER_KEY, order);
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
  if (typeof localStorage === "undefined") return "device";
  const stored = localStorage.getItem(TIMER_ID_KEY);
  if (stored) return stored;
  const minted = `d-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(TIMER_ID_KEY, minted);
  return minted;
}

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
  if (typeof localStorage === "undefined") return { eventIndex: 0, heatIndex: 0 };
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRESS_PREFIX + meetId) ?? "");
    return {
      eventIndex: Number(stored?.eventIndex) || 0,
      heatIndex: Number(stored?.heatIndex) || 0,
    };
  } catch {
    return { eventIndex: 0, heatIndex: 0 };
  }
}

export function saveProgress(meetId: string, progress: Progress): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PROGRESS_PREFIX + meetId, JSON.stringify(progress));
}

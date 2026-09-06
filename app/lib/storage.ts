/**
 * Device-local preferences. The meet and team documents live in IndexedDB
 * (see `db.ts`); everything here is deliberately per-device and is never
 * synced or exported.
 */

import { LANE_LAYOUTS, type LaneLayout } from "~/types/meet";

const AUTO_SYNC_KEY = "meet-runner:auto-sync";
const TOKEN_KEY = "meet-runner:sync-token";
const SESSION_KEY = "meet-runner:session";
const LANE_LAYOUT_KEY = "meet-runner:lane-layout";
const TIMER_ID_KEY = "meet-runner:timer-id";

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

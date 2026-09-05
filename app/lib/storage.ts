/**
 * Device-local preferences. The meet and team documents live in IndexedDB
 * (see `db.ts`); everything here is deliberately per-device and is never
 * synced or exported.
 */

import { LANE_LAYOUTS, type LaneLayout } from "~/types/meet";

const AUTO_SYNC_KEY = "meet-runner:auto-sync";
const TOKEN_KEY = "meet-runner:sync-token";
const LANE_LAYOUT_KEY = "meet-runner:lane-layout";

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

/**
 * Device-local preferences. The meet and team documents live in IndexedDB
 * (see `db.ts`); everything here is deliberately per-device and is never
 * synced or exported.
 */

const AUTO_SYNC_KEY = "meet-runner:auto-sync";
const TOKEN_KEY = "meet-runner:sync-token";

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

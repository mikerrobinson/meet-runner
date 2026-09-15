/**
 * Small, durable facts about this device.
 *
 * Cookies rather than localStorage, for one reason: they work in more places.
 * A timer's phone is a stranger's phone, opened from a camera app into
 * whichever browser it felt like using — a private window, an in-app webview,
 * something with storage switched off by policy. Those refuse or throw on
 * `localStorage` often enough to matter, and cookies are the mechanism that
 * survives them. Being sent to the server for free is a side benefit nothing
 * here actually uses.
 *
 * Only for things that are *small and bounded*. Every cookie is uploaded on
 * every request to this path, and a browser that is handed more than about
 * 4KB doesn't complain — it silently drops the write. That makes them exactly
 * wrong for anything that grows, like a queue of times waiting to send: the
 * failure mode is a lost time with nothing on screen to say so.
 */

import { appBasePath } from "./http";

/** A year. These identify a device, not a session. */
export const A_YEAR = 60 * 60 * 24 * 365;
/** Long enough to cover a meet and the trip home, short enough to go stale. */
export const A_WEEK = 60 * 60 * 24 * 7;

export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Write one, scoped to this app.
 *
 * Not `HttpOnly` — this side has to read them back, and none of them is a
 * credential. The grant is the only credential a timer has, and it is set by
 * the server precisely so that nothing here can touch it.
 */
export function writeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${name}=${encodeURIComponent(value)}` +
    `; Path=${appBasePath()}; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function deleteCookie(name: string): void {
  writeCookie(name, "", 0);
}

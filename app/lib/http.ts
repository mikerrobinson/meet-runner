/**
 * Where this app lives, and what a call to it can go wrong with.
 *
 * Everything is served under a basename in production and at the root in dev,
 * so anything building a URL by hand goes through here.
 *
 * This file used to hold a `request` helper too — the one place that knew what
 * credentials to attach to a call. Nothing is left to attach: the session is
 * an `HttpOnly` cookie the browser sends by itself, and every screen asks its
 * own loader rather than an endpoint. What still calls out by hand is the
 * outbox and the timer, neither of which has a page behind it.
 */

/**
 * Resolve an API path against the router basename, so the same code works at
 * `/` in dev and `/` in production.
 */
export function apiUrl(path: string): string {
  if (typeof document === "undefined") return path;
  return `${appBasePath().replace(/\/$/, "")}${path}`;
}

/**
 * Where this app lives, with a trailing slash: `/` in dev and
 * `/` in production.
 *
 * Shared by the API path and the cookie `Path`, so a cookie this device writes
 * is scoped to exactly the requests that should carry it — and can't be read
 * by, or leak into, whatever else is hosted on the domain.
 */
export function appBasePath(): string {
  if (typeof document === "undefined") return "/";
  const base = document.querySelector("base")?.getAttribute("href");
  const prefix = base ?? import.meta.env.BASE_URL ?? "/";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/** Carries the HTTP status so callers can tell "misconfigured" from "offline". */
export class ApiError extends Error {
  constructor(
    message: string,
    /** 0 when the request never reached the server. */
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

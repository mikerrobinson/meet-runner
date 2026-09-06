/**
 * Talking to this app's own API.
 *
 * One place that knows where the API is and what credentials to attach, so
 * syncing and signing in can't drift apart on either question.
 */

import { loadSessionToken, loadSyncToken } from "./storage";

/**
 * Resolve an API path against the router basename, so the same code works at
 * `/` in dev and `/projects/meet-runner/` in production.
 */
export function apiUrl(path: string): string {
  if (typeof document === "undefined") return path;
  const base = document.querySelector("base")?.getAttribute("href");
  const prefix = (base ?? import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return `${prefix}${path}`;
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

/**
 * A request with whatever this device can prove about itself attached.
 *
 * Both credentials go along when they exist: the session says who you are, and
 * the older shared token says the worker will talk to you at all. They answer
 * different questions, and a device mid-transition may need both.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const syncToken = loadSyncToken();
  const session = loadSessionToken();

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(syncToken ? { "x-sync-token": syncToken } : {}),
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // No network, DNS failure, request aborted — nothing reached the server.
    throw new ApiError("Couldn't reach the server", 0);
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

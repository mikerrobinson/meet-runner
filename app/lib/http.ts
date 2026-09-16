/**
 * Talking to this app's own API.
 *
 * One place that knows where the API is and what credentials to attach, so
 * syncing and signing in can't drift apart on either question.
 */

/**
 * Resolve an API path against the router basename, so the same code works at
 * `/` in dev and `/projects/meet-runner/` in production.
 */
export function apiUrl(path: string): string {
  if (typeof document === "undefined") return path;
  return `${appBasePath().replace(/\/$/, "")}${path}`;
}

/**
 * Where this app lives, with a trailing slash: `/` in dev and
 * `/projects/meet-runner/` in production.
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

/**
 * A request to this app's own API.
 *
 * Nothing is attached. Who is asking rides in the session cookie, which is
 * `HttpOnly` and sent by the browser on every same-origin request — so there
 * is no credential in this file to forget, and none in `localStorage` for a
 * script on the page to read. Two headers used to be assembled here, a shared
 * "sync token" and a copy of the session; by the end both were empty strings.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
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

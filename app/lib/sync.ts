import { migrateMeet, migrateTeam } from "./documents";
import { loadSyncToken } from "./storage";
import type { MeetDoc, TeamDoc } from "~/types/meet";

export interface RemoteMeetSummary {
  /** Set when the meet was deleted; the summary is a tombstone. */
  deletedAt?: number | null;
  id: string;
  name: string;
  date: string;
  updatedAt: number;
}

/**
 * Resolve an API path against the router basename, so the same code works at
 * `/` in dev and `/projects/meet-runner/` in production.
 */
function apiUrl(path: string): string {
  if (typeof document === "undefined") return path;
  const base = document.querySelector("base")?.getAttribute("href");
  const prefix = (base ?? import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return `${prefix}${path}`;
}

/** Carries the HTTP status so callers can tell "misconfigured" from "offline". */
export class SyncRequestError extends Error {
  constructor(
    message: string,
    /** 0 when the request never reached the server. */
    readonly status: number,
  ) {
    super(message);
    this.name = "SyncRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = loadSyncToken();

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-sync-token": token } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // No network, DNS failure, request aborted — nothing reached the server.
    throw new SyncRequestError("Couldn't reach the server", 0);
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      `Request failed (${response.status})`;
    throw new SyncRequestError(message, response.status);
  }

  return body as T;
}

/** Push the local meet to the server. Server keeps whichever copy is newer. */
export async function pushMeet(
  meet: MeetDoc,
): Promise<{ updatedAt: number; applied: boolean }> {
  return request(`/api/meets/${meet.id}`, {
    method: "PUT",
    body: JSON.stringify(meet),
  });
}

/** Fetch a meet by id. Returns null if the server doesn't have it. */
export async function pullMeet(id: string): Promise<MeetDoc | null> {
  const body = await request<{ meet: unknown | null }>(`/api/meets/${id}`);
  return body.meet ? migrateMeet(body.meet) : null;
}

export async function listMeets(): Promise<RemoteMeetSummary[]> {
  const body = await request<{ meets: RemoteMeetSummary[] }>("/api/meets");
  return body.meets;
}

/** Push the season roster and team settings. */
export async function pushTeam(
  team: TeamDoc,
): Promise<{ updatedAt: number; applied: boolean }> {
  return request("/api/team", { method: "PUT", body: JSON.stringify(team) });
}

export async function pullTeam(): Promise<TeamDoc | null> {
  const body = await request<{ team: unknown | null }>("/api/team");
  return body.team ? migrateTeam(body.team) : null;
}

/** Whether the server has sync configured at all (i.e. a D1 binding exists). */
export async function syncStatus(): Promise<{ enabled: boolean; reason?: string }> {
  try {
    return await request("/api/sync-status");
  } catch (error) {
    return {
      enabled: false,
      reason: error instanceof Error ? error.message : "Server unreachable",
    };
  }
}

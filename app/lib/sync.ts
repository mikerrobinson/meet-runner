/**
 * Talking to the sync endpoint. One request carries this device's changes up
 * and brings back everything that changed elsewhere; see `objects.ts` for what
 * a change is, and `auto-sync.tsx` for when this gets called.
 */

import { request } from "./http";
import type { SyncObject } from "./objects";

export { ApiError as SyncRequestError } from "./http";

export interface SyncExchange {
  cursor: string;
  changes: SyncObject[];
  more: boolean;
  applied: number;
  /** Objects the server refused because its copy was edited more recently. */
  refused: SyncObject[];
}

/**
 * One round trip: hand over what changed here, take back what changed
 * elsewhere. On pool wifi the round trip is the expense, not the bytes.
 */
export async function exchange(
  teamId: string,
  cursor: string,
  changes: SyncObject[],
): Promise<SyncExchange> {
  return request("/api/sync", {
    method: "POST",
    body: JSON.stringify({ teamId, cursor, changes }),
  });
}

export interface RemoteTeamSummary {
  id: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
  /** Recorded times — the surest sign of which season is the real one. */
  times: number;
  updatedAt: number;
}

/** Every season on the server, for a device deciding which one it belongs to. */
export async function listTeams(): Promise<RemoteTeamSummary[]> {
  const body = await request<{ teams: RemoteTeamSummary[] }>("/api/teams");
  return body.teams;
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

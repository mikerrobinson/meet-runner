/**
 * Document shapes, defaults, and version migrations.
 *
 * Pure and environment-free on purpose: the browser storage layer and the
 * Cloudflare Worker both need these, and the worker shouldn't be dragging
 * IndexedDB code into its bundle to get them.
 */

import { generateId } from "./id";
import {
  MEET_DOC_VERSION,
  TEAM_DOC_VERSION,
  type LaneLayout,
  type MeetDoc,
  type MeetType,
  type Swimmer,
  type TeamDoc,
} from "~/types/meet";

export function createTeam(name = "My Team"): TeamDoc {
  return {
    version: TEAM_DOC_VERSION,
    id: generateId(),
    name,
    season: String(new Date().getFullYear()),
    swimmers: [],
    updatedAt: Date.now(),
    syncedAt: null,
  };
}

export function createMeetDoc(
  teamId: string,
  patch: Partial<MeetDoc> = {},
): MeetDoc {
  return {
    version: MEET_DOC_VERSION,
    id: generateId(),
    teamId,
    name: "New Meet",
    date: new Date().toISOString().slice(0, 10),
    type: "dual",
    options: { laneCount: 6, laneLayout: "grid" },
    events: [],
    entries: {},
    heats: [],
    results: [],
    progress: { eventIndex: 0, heatIndex: 0 },
    timer: null,
    updatedAt: Date.now(),
    syncedAt: null,
    ...patch,
  };
}

export function normalizeSwimmer(raw: Partial<Swimmer> & { active?: boolean }): Swimmer {
  return {
    id: raw.id ?? generateId(),
    firstName: raw.firstName ?? "",
    lastName: raw.lastName ?? "",
    gender: raw.gender === "M" ? "M" : "F",
    year: raw.year ?? "",
    squad: raw.squad || undefined,
    // Pre-roster saves used `active` to mean "swimming this meet"; the closest
    // season-long equivalent is being off the roster.
    archived: raw.archived ?? raw.active === false,
  };
}

export function migrateTeam(input: unknown): TeamDoc | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Partial<TeamDoc>;
  if (!doc.id || !Array.isArray(doc.swimmers)) return null;
  return {
    version: TEAM_DOC_VERSION,
    id: doc.id,
    name: doc.name ?? "My Team",
    season: doc.season ?? String(new Date().getFullYear()),
    swimmers: doc.swimmers.map(normalizeSwimmer),
    updatedAt: doc.updatedAt ?? Date.now(),
    syncedAt: doc.syncedAt ?? null,
  };
}

const MEET_TYPES = new Set<MeetType>([
  "intersquad",
  "dual",
  "tri",
  "invitational",
  "time-trial",
]);

export function migrateMeet(input: unknown, teamId?: string): MeetDoc | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Partial<MeetDoc> & { swimmers?: unknown };
  if (!doc.id || !Array.isArray(doc.events)) return null;

  const laneCount = doc.options?.laneCount;
  const laneLayout = doc.options?.laneLayout as LaneLayout | undefined;

  return {
    version: MEET_DOC_VERSION,
    id: doc.id,
    teamId: doc.teamId ?? teamId ?? "",
    name: doc.name ?? "Untitled Meet",
    date: doc.date ?? new Date().toISOString().slice(0, 10),
    type: doc.type && MEET_TYPES.has(doc.type) ? doc.type : "dual",
    opponent: doc.opponent || undefined,
    options: {
      laneCount: laneCount === 4 || laneCount === 8 ? laneCount : 6,
      laneLayout:
        laneLayout === "list-asc" || laneLayout === "list-desc"
          ? laneLayout
          : "grid",
    },
    events: doc.events,
    entries: doc.entries ?? {},
    heats: doc.heats ?? [],
    results: doc.results ?? [],
    progress: doc.progress ?? { eventIndex: 0, heatIndex: 0 },
    timer: doc.timer ?? null,
    updatedAt: doc.updatedAt ?? Date.now(),
    syncedAt: doc.syncedAt ?? null,
  };
}

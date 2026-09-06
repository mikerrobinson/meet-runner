/**
 * Document shapes, defaults, and version migrations.
 *
 * Pure and environment-free on purpose: the browser storage layer and the
 * Cloudflare Worker both need these, and the worker shouldn't be dragging
 * IndexedDB code into its bundle to get them.
 */

import { generateId } from "./id";
import { makeSeason } from "./roster";
import {
  MEET_DOC_VERSION,
  TEAM_DOC_VERSION,
  isLaneCount,
  isMeetCourse,
  normalizeTeamCode,
  type MeetDoc,
  type MeetOptions,
  type MeetType,
  type Swimmer,
  type TeamDoc,
} from "~/types/meet";

export function createTeam(name = "My Team"): TeamDoc {
  const id = generateId();
  const season = makeSeason(id, defaultSeasonName());
  return {
    version: TEAM_DOC_VERSION,
    id,
    name,
    code: "",
    nameOrder: "last",
    currentSeasonId: season.id,
    seasons: [season],
    swimmers: [],
    enrollments: [],
    updatedAt: Date.now(),
    syncedAt: null,
  };
}

/**
 * A school year rather than a calendar one: a season starting in autumn runs
 * into the next year, which is how coaches write it.
 */
export function defaultSeasonName(now = new Date()): string {
  const year = now.getFullYear();
  // Before July the season began last year.
  const start = now.getMonth() < 6 ? year - 1 : year;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A patch may set just one option and leave the rest at their defaults. */
export type MeetPatch = Partial<Omit<MeetDoc, "options">> & {
  options?: Partial<MeetOptions>;
};

export function createMeetDoc(teamId: string, patch: MeetPatch = {}): MeetDoc {
  const defaults: MeetDoc = {
    version: MEET_DOC_VERSION,
    id: generateId(),
    teamId,
    name: "New Meet",
    date: new Date().toISOString().slice(0, 10),
    type: "dual",
    course: "SCY",
    options: {
      laneCount: 6,
      leadGender: "F",
      includeDiving: true,
    },
    events: [],
    entries: {},
    heats: [],
    watches: [],
    rulings: [],
    progress: { eventIndex: 0, heatIndex: 0 },
    timer: null,
    updatedAt: Date.now(),
    syncedAt: null,
  };
  const doc: MeetDoc = {
    ...defaults,
    ...patch,
    options: { ...defaults.options, ...patch.options },
  };
  // The lineup is the truth about diving — a meet started from an empty event
  // list has no Diving event, so the option shouldn't claim otherwise.
  return {
    ...doc,
    options: {
      ...doc.options,
      includeDiving: doc.events.some((e) => e.stroke === "Diving"),
    },
  };
}

export function normalizeSwimmer(raw: Partial<Swimmer>): Swimmer {
  return {
    id: raw.id ?? generateId(),
    firstName: raw.firstName ?? "",
    lastName: raw.lastName ?? "",
    gender: raw.gender === "M" ? "M" : "F",
    birthDate: raw.birthDate || undefined,
  };
}

/**
 * Check and fill in a team document.
 *
 * Not a migration any more — the shapes that needed converting were converted
 * once, and the app writes only this one. What's left is making sure a
 * document off the wire or out of a backup file has everything it should.
 */
export function migrateTeam(input: unknown): TeamDoc | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Partial<TeamDoc>;
  if (!doc.id || !Array.isArray(doc.swimmers)) return null;

  const seasons = doc.seasons ?? [];
  const currentSeasonId =
    seasons.find((s) => s.id === doc.currentSeasonId)?.id ??
    seasons[seasons.length - 1]?.id ??
    "";

  return {
    version: TEAM_DOC_VERSION,
    id: doc.id,
    name: doc.name ?? "My Team",
    code: normalizeTeamCode(doc.code ?? ""),
    headCoach: doc.headCoach || undefined,
    nameOrder: doc.nameOrder === "first" ? "first" : "last",
    currentSeasonId,
    seasons,
    swimmers: doc.swimmers.map(normalizeSwimmer),
    enrollments: doc.enrollments ?? [],
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

/** Check and fill in a meet document. See `migrateTeam`. */
export function migrateMeet(input: unknown, teamId?: string): MeetDoc | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Partial<MeetDoc>;
  if (!doc.id || !Array.isArray(doc.events)) return null;

  const laneCount = doc.options?.laneCount;

  return {
    version: MEET_DOC_VERSION,
    id: doc.id,
    teamId: doc.teamId ?? teamId ?? "",
    name: doc.name ?? "Untitled Meet",
    date: doc.date ?? new Date().toISOString().slice(0, 10),
    type: doc.type && MEET_TYPES.has(doc.type) ? doc.type : "dual",
    course: isMeetCourse(doc.course) ? doc.course : "SCY",
    location: doc.location || undefined,
    options: {
      laneCount: isLaneCount(laneCount) ? laneCount : 6,
      leadGender: doc.options?.leadGender === "M" ? "M" : "F",
      includeDiving:
        doc.options?.includeDiving ??
        (doc.events ?? []).some((e) => e.stroke === "Diving"),
    },
    events: doc.events,
    entries: doc.entries ?? {},
    heats: doc.heats ?? [],
    watches: doc.watches ?? [],
    rulings: doc.rulings ?? [],
    progress: doc.progress ?? { eventIndex: 0, heatIndex: 0 },
    timer: doc.timer ?? null,
    // Absent on a live meet rather than an explicit null, so a document that
    // was never deleted is byte-for-byte what it always was.
    deletedAt: doc.deletedAt || undefined,
    updatedAt: doc.updatedAt ?? Date.now(),
    syncedAt: doc.syncedAt ?? null,
  };
}

/**
 * What's left of a meet once it's deleted: enough to identify it and to tell
 * another device to drop its copy, and none of the bulk.
 */
export function tombstone(meet: MeetDoc): MeetDoc {
  return {
    ...createMeetDoc(meet.teamId, {
      id: meet.id,
      name: meet.name,
      date: meet.date,
      type: meet.type,
      course: meet.course,
    }),
    deletedAt: Date.now(),
    updatedAt: Date.now(),
    syncedAt: meet.syncedAt,
  };
}

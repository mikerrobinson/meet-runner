/**
 * Document shapes, defaults, and version migrations.
 *
 * Pure and environment-free on purpose: the browser storage layer and the
 * Cloudflare Worker both need these, and the worker shouldn't be dragging
 * IndexedDB code into its bundle to get them.
 */

import { generateId } from "./id";
import { makeEnrollment, makeSeason } from "./roster";
import {
  MEET_DOC_VERSION,
  TEAM_DOC_VERSION,
  isLaneCount,
  isMeetCourse,
  normalizeTeamCode,
  rulingId,
  watchId,
  type MeetDoc,
  type MeetOptions,
  type MeetType,
  type ResultStatus,
  type Ruling,
  type WatchTime,
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

/** A swimmer as stored before enrollments existed, or as a backup holds one. */
type LegacySwimmer = Partial<Swimmer> & {
  active?: boolean;
  archived?: boolean;
  year?: string;
  squad?: string;
};

export function normalizeSwimmer(raw: LegacySwimmer): Swimmer {
  return {
    id: raw.id ?? generateId(),
    firstName: raw.firstName ?? "",
    lastName: raw.lastName ?? "",
    gender: raw.gender === "M" ? "M" : "F",
    birthDate: raw.birthDate || undefined,
  };
}

export function migrateTeam(input: unknown): TeamDoc | null {
  if (!input || typeof input !== "object") return null;
  const doc = input as Partial<TeamDoc> & { season?: string };
  if (!doc.id || !Array.isArray(doc.swimmers)) return null;

  const swimmers = (doc.swimmers as LegacySwimmer[]).map(normalizeSwimmer);

  // Before seasons, the roster was a flat list on the team and the season was
  // a label. That's one unbounded season with everyone enrolled in it — grade,
  // squad and the old `archived` flag become facts about the enrollment.
  const legacySeason =
    doc.seasons === undefined
      ? makeSeason(doc.id, doc.season || defaultSeasonName())
      : null;

  const seasons = legacySeason ? [legacySeason] : (doc.seasons ?? []);
  const enrollments = legacySeason
    ? (doc.swimmers as LegacySwimmer[]).map((raw, i) =>
        makeEnrollment(doc.id!, legacySeason.id, swimmers[i].id, {
          year: raw.year,
          squad: raw.squad,
          status:
            (raw.archived ?? raw.active === false) ? "inactive" : "active",
        }),
      )
    : (doc.enrollments ?? []);

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
    swimmers,
    enrollments,
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
  // "format" was this field's name for a day; "course" is the domain word.
  const course = doc.course ?? (doc as { format?: unknown }).format;
  const leadGender = doc.options?.leadGender;

  return {
    version: MEET_DOC_VERSION,
    id: doc.id,
    teamId: doc.teamId ?? teamId ?? "",
    name: doc.name ?? "Untitled Meet",
    date: doc.date ?? new Date().toISOString().slice(0, 10),
    type: doc.type && MEET_TYPES.has(doc.type) ? doc.type : "dual",
    // Saves predating the field were all high-school yards.
    course: isMeetCourse(course) ? course : "SCY",
    location: doc.location || undefined,
    options: {
      laneCount: isLaneCount(laneCount) ? laneCount : 6,
      leadGender: leadGender === "M" ? "M" : "F",
      // Older saves predate the option; infer it from what's actually there.
      includeDiving:
        doc.options?.includeDiving ??
        (doc.events ?? []).some((e) => e.stroke === "Diving"),
    },
    events: doc.events,
    entries: doc.entries ?? {},
    heats: doc.heats ?? [],
    ...migrateTiming(doc),
    progress: doc.progress ?? { eventIndex: 0, heatIndex: 0 },
    timer: doc.timer ?? null,
    // Absent on a live meet rather than an explicit null, so a document that
    // was never deleted is byte-for-byte what it always was.
    deletedAt: doc.deletedAt || undefined,
    updatedAt: doc.updatedAt ?? Date.now(),
    syncedAt: doc.syncedAt ?? null,
  };
}

/** A recorded time as it was stored before lanes could hold several. */
interface LegacyResult {
  id?: string;
  eventId?: string;
  heatId?: string;
  lane?: number;
  timeMs?: number;
  status?: ResultStatus;
  recordedAt?: number;
  manual?: boolean;
}

/**
 * Bring recorded times forward to watches and rulings.
 *
 * Every time already saved was taken by one person, so it becomes that
 * person's single watch — credited to "legacy" because we don't know whose it
 * was, which keeps its id stable and stops a second import duplicating it.
 * Anything that wasn't a plain OK carries a ruling as well, since a DQ is a
 * judgement rather than something a stopwatch said.
 */
function migrateTiming(
  doc: Partial<MeetDoc> & { results?: LegacyResult[] },
): Pick<MeetDoc, "watches" | "rulings"> {
  if (doc.watches || doc.rulings) {
    return { watches: doc.watches ?? [], rulings: doc.rulings ?? [] };
  }

  const watches: WatchTime[] = [];
  const rulings: Ruling[] = [];

  for (const old of doc.results ?? []) {
    if (!old.heatId || !old.eventId || !old.lane) continue;
    const base = {
      eventId: old.eventId,
      heatId: old.heatId,
      lane: old.lane,
    };

    if (typeof old.timeMs === "number" && old.timeMs > 0) {
      watches.push({
        ...base,
        id: watchId(old.heatId, old.lane, LEGACY_TIMER),
        timerId: LEGACY_TIMER,
        timeMs: old.timeMs,
        recordedAt: old.recordedAt ?? Date.now(),
        source: old.manual ? "typed" : "stopwatch",
      });
    }

    if (old.status && old.status !== "OK") {
      rulings.push({
        ...base,
        id: rulingId(old.heatId, old.lane),
        status: old.status,
        decidedAt: old.recordedAt ?? Date.now(),
      });
    }
  }

  return { watches, rulings };
}

/** Credited timer for times recorded before there were timers to credit. */
const LEGACY_TIMER = "legacy";

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

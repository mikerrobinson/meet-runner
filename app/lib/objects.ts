/**
 * The season as a set of small objects, rather than two big documents.
 *
 * Documents are what the app thinks in — a `TeamDoc` with a roster, a
 * `MeetDoc` with heats and times — and that doesn't change. What changes is
 * what goes over the wire: a athlete added on the laptop and a time recorded
 * on the iPad are separate objects, so they merge instead of one clobbering
 * the other.
 *
 * Everything here is pure. Decomposing and recomposing a season must give the
 * same season back, which is the property the tests pin down.
 */

import { MEET_DOC_VERSION, TEAM_DOC_VERSION } from "~/types/meet";
import type {
  Enrollment,
  Entries,
  Heat,
  MeetDoc,
  MeetEvent,
  Ruling,
  Season,
  Athlete,
  TeamDoc,
  WatchTime,
} from "~/types/meet";

export type SyncObjectType =
  | "team"
  | "season"
  | "athlete"
  | "enrollment"
  | "meet"
  | "lineup"
  | "entry"
  | "heat"
  | "watch"
  | "ruling";

/**
 * One syncable thing.
 *
 * `teamId` is on every object so the server can answer "everything for this
 * team since T" with one query, and so nothing can drift into another team's
 * season by accident.
 */
export interface SyncObject {
  id: string;
  type: SyncObjectType;
  teamId: string;
  updatedAt: number;
  /** Set when the object was deleted; its `data` is then meaningless. */
  deletedAt?: number;
  data: unknown;
}

/** The bits of a team that aren't its people or its seasons. */
interface TeamCore {
  name: string;
  code: string;
  headCoach?: string;
  nameOrder: TeamDoc["nameOrder"];
  currentSeasonId: string;
}

/** The bits of a meet that aren't its lineup, entries, heats or times. */
interface MeetCore {
  name: string;
  date: string;
  type: MeetDoc["type"];
  course: MeetDoc["course"];
  location?: string;
  teams?: string[];
  options: MeetDoc["options"];
  timer: MeetDoc["timer"];
}

export function entryId(
  meetId: string,
  eventId: string,
  athleteId: string,
): string {
  return `${meetId}:${eventId}:${athleteId}`;
}

/* ------------------------------------------------------------- decomposing */

/**
 * Break a season into objects.
 *
 * `progress` is deliberately left behind: where a device has scrolled to in
 * the running order is nobody else's business, and syncing it would put a
 * write on the wire every time someone taps an arrow.
 */
export function toObjects(team: TeamDoc, meets: MeetDoc[]): SyncObject[] {
  const at = team.updatedAt;
  const objects: SyncObject[] = [];

  const core: TeamCore = {
    name: team.name,
    code: team.code,
    headCoach: team.headCoach,
    nameOrder: team.nameOrder,
    currentSeasonId: team.currentSeasonId,
  };
  objects.push({
    id: team.id,
    type: "team",
    teamId: team.id,
    updatedAt: at,
    data: core,
  });

  for (const season of team.seasons) {
    objects.push({
      id: season.id,
      type: "season",
      teamId: team.id,
      updatedAt: at,
      data: season,
    });
  }
  for (const athlete of team.athletes) {
    objects.push({
      id: athlete.id,
      type: "athlete",
      teamId: team.id,
      updatedAt: at,
      data: athlete,
    });
  }
  for (const enrollment of team.enrollments) {
    objects.push({
      id: enrollment.id,
      type: "enrollment",
      teamId: team.id,
      updatedAt: at,
      data: enrollment,
    });
  }

  for (const meet of meets) {
    objects.push(...meetObjects(meet));
  }

  return objects;
}

function meetObjects(meet: MeetDoc): SyncObject[] {
  const at = meet.updatedAt;
  const scope = { teamId: meet.teamId, updatedAt: at };

  // A deleted meet is one tombstone and nothing else — its parts went with it.
  if (meet.deletedAt) {
    const core: MeetCore = {
      name: meet.name,
      date: meet.date,
      type: meet.type,
      course: meet.course,
      location: meet.location,
      teams: meet.teams,
      options: meet.options,
      timer: null,
    };
    return [
      {
        id: meet.id,
        type: "meet",
        ...scope,
        deletedAt: meet.deletedAt,
        data: core,
      },
    ];
  }

  const core: MeetCore = {
    name: meet.name,
    date: meet.date,
    type: meet.type,
    course: meet.course,
    location: meet.location,
    teams: meet.teams,
    options: meet.options,
    timer: meet.timer,
  };

  const objects: SyncObject[] = [
    { id: meet.id, type: "meet", ...scope, data: core },
    // The running order is one object: reordering is a statement about the
    // whole list, and merging two reorderings per-event would produce a
    // programme neither coach wrote.
    {
      id: meet.id,
      type: "lineup",
      ...scope,
      data: { meetId: meet.id, events: meet.events },
    },
  ];

  for (const [eventId, athleteIds] of Object.entries(meet.entries)) {
    for (const athleteId of athleteIds) {
      objects.push({
        id: entryId(meet.id, eventId, athleteId),
        type: "entry",
        ...scope,
        data: { meetId: meet.id, eventId, athleteId },
      });
    }
  }
  for (const heat of meet.heats) {
    objects.push({
      id: heat.id,
      type: "heat",
      ...scope,
      data: { meetId: meet.id, ...heat },
    });
  }
  for (const watch of meet.watches) {
    objects.push({
      id: watch.id,
      type: "watch",
      ...scope,
      data: { meetId: meet.id, ...watch },
    });
  }
  for (const ruling of meet.rulings) {
    objects.push({
      id: ruling.id,
      type: "ruling",
      ...scope,
      data: { meetId: meet.id, ...ruling },
    });
  }

  return objects;
}

/* -------------------------------------------------------------- recomposing */

/**
 * Put a season back together from its objects.
 *
 * Anything whose parent is missing is dropped rather than guessed at: an
 * entry for a meet this device doesn't have is not information, it's noise.
 */
export function fromObjects(objects: SyncObject[]): {
  team: TeamDoc | null;
  meets: MeetDoc[];
} {
  const live = objects.filter((o) => !o.deletedAt);
  const of = <T,>(type: SyncObjectType): Array<SyncObject & { data: T }> =>
    live.filter((o) => o.type === type) as Array<SyncObject & { data: T }>;

  const teamObject = of<TeamCore>("team")[0];
  if (!teamObject) return { team: null, meets: [] };

  const team: TeamDoc = {
    version: TEAM_VERSION,
    id: teamObject.id,
    ...teamObject.data,
    seasons: of<Season>("season").map((o) => o.data),
    athletes: of<Athlete>("athlete").map((o) => o.data),
    enrollments: of<Enrollment>("enrollment").map((o) => o.data),
    updatedAt: teamObject.updatedAt,
  };

  const byMeet = new Map<string, MeetDoc>();
  for (const object of of<MeetCore>("meet")) {
    byMeet.set(object.id, {
      version: MEET_VERSION,
      id: object.id,
      teamId: object.teamId,
      ...object.data,
      events: [],
      entries: {},
      heats: [],
      watches: [],
      rulings: [],
      progress: { eventIndex: 0, heatIndex: 0 },
      updatedAt: object.updatedAt,
    });
  }

  for (const o of of<{ meetId: string; events: MeetEvent[] }>("lineup")) {
    const meet = byMeet.get(o.data.meetId);
    if (meet) meet.events = o.data.events;
  }
  for (const o of of<{ meetId: string; eventId: string; athleteId: string }>(
    "entry",
  )) {
    const meet = byMeet.get(o.data.meetId);
    if (!meet) continue;
    const list = meet.entries[o.data.eventId] ?? [];
    list.push(o.data.athleteId);
    meet.entries[o.data.eventId] = list;
  }
  for (const o of of<Heat & { meetId: string }>("heat")) {
    const meet = byMeet.get(o.data.meetId);
    if (!meet) continue;
    const { meetId, ...heat } = o.data;
    meet.heats.push(heat);
  }
  for (const o of of<WatchTime & { meetId: string }>("watch")) {
    const meet = byMeet.get(o.data.meetId);
    if (!meet) continue;
    const { meetId, ...watch } = o.data;
    meet.watches.push(watch);
  }
  for (const o of of<Ruling & { meetId: string }>("ruling")) {
    const meet = byMeet.get(o.data.meetId);
    if (!meet) continue;
    const { meetId, ...ruling } = o.data;
    meet.rulings.push(ruling);
  }

  // Heats are read by index everywhere; entries and times are sets, but a
  // stable order keeps documents comparable.
  for (const meet of byMeet.values()) {
    meet.heats.sort((a, b) => a.eventId.localeCompare(b.eventId) || a.index - b.index);
    meet.watches.sort((a, b) => a.id.localeCompare(b.id));
    meet.rulings.sort((a, b) => a.id.localeCompare(b.id));
    for (const list of Object.values(meet.entries)) list.sort();
  }

  return { team, meets: [...byMeet.values()] };
}

/** Document versions the recomposed documents claim. Kept in step with the model. */
const TEAM_VERSION = TEAM_DOC_VERSION;
const MEET_VERSION = MEET_DOC_VERSION;

/* ------------------------------------------------------------------ diffing */

/**
 * What changed since the last time we looked.
 *
 * Compares by content rather than trusting a timestamp: the documents stamp
 * one `updatedAt` for the whole document, so a single lane tap would
 * otherwise look like every object in the meet had changed. Only objects
 * whose contents actually differ go over the wire.
 */
export function changedObjects(
  previous: SyncObject[],
  current: SyncObject[],
  now = Date.now(),
): SyncObject[] {
  const before = new Map(previous.map((o) => [key(o), o] as const));
  const changes: SyncObject[] = [];
  const seen = new Set<string>();

  for (const object of current) {
    const k = key(object);
    seen.add(k);
    const old = before.get(k);
    if (!old || !sameContent(old, object)) changes.push(object);
  }

  // Anything that was there and isn't any more has been removed from its
  // document — an un-entered athlete, a discarded watch — so it's a deletion.
  for (const [k, old] of before) {
    if (seen.has(k) || old.deletedAt) continue;
    changes.push({ ...old, deletedAt: now, updatedAt: now });
  }

  return changes;
}

function key(object: SyncObject): string {
  return `${object.type}:${object.id}`;
}

function sameContent(a: SyncObject, b: SyncObject): boolean {
  return (
    (a.deletedAt ?? null) === (b.deletedAt ?? null) &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}

/**
 * Fold incoming objects into a set, newest wins per object.
 *
 * This is the whole point of the exercise: two devices touching different
 * objects both land, and only a genuine edit to the same object is a contest.
 */
export function mergeObjects(
  base: SyncObject[],
  incoming: SyncObject[],
): SyncObject[] {
  const merged = new Map(base.map((o) => [key(o), o] as const));
  for (const object of incoming) {
    const existing = merged.get(key(object));
    if (!existing || object.updatedAt >= existing.updatedAt) {
      merged.set(key(object), object);
    }
  }
  return [...merged.values()];
}

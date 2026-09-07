/**
 * The season as a set of small objects, rather than a few big documents.
 *
 * Documents are what the app thinks in — a `TeamDoc` with its seasons, a
 * `MeetDoc` with heats and times — and that doesn't change. What changes is
 * what goes over the wire: an athlete added on the laptop and a time recorded
 * on the iPad are separate objects, so they merge instead of one clobbering
 * the other.
 *
 * Every object carries a **scope**, which is the one thing the server needs in
 * order to answer "what changed?" without being handed the whole model:
 *
 *   team    — seasons and enrollments, the things a team owns
 *   meet    — the lineup, entries, heats, watches and rulings of one day
 *   global  — athletes, who belong to no team and outlive every meet
 *
 * Scoping meets by their own id rather than by an owning team is what lets two
 * schools work the same dual meet. Both pull `meet:{id}`; neither owns it.
 *
 * Everything here is pure. Decomposing and recomposing must give the same
 * model back, which is the property the tests pin down.
 */

import { MEET_DOC_VERSION, TEAM_DOC_VERSION } from "~/types/meet";
import type {
  Enrollment,
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
 * What an object belongs to.
 *
 * Three kinds rather than one team id, because the three have genuinely
 * different lifetimes: a team outlives its meets, a meet outlives nobody, and
 * a person outlives both.
 */
export type ObjectScope =
  | { kind: "team"; id: string }
  | { kind: "meet"; id: string }
  | { kind: "global" };

export function teamScope(id: string): ObjectScope {
  return { kind: "team", id };
}

export function meetScope(id: string): ObjectScope {
  return { kind: "meet", id };
}

export const GLOBAL: ObjectScope = { kind: "global" };

/** A scope as one string, for indexes, comparisons and map keys. */
export function scopeKey(scope: ObjectScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
}

export function sameScope(a: ObjectScope, b: ObjectScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** One syncable thing. */
export interface SyncObject {
  id: string;
  type: SyncObjectType;
  scope: ObjectScope;
  updatedAt: number;
  /** Set when the object was deleted; its `data` is then meaningless. */
  deletedAt?: number;
  data: unknown;
}

/** The bits of a team that aren't its seasons or its roster. */
interface TeamCore {
  name: string;
  code: string;
  currentSeasonId: string;
}

/** The bits of a meet that aren't its lineup, entries, heats or times. */
interface MeetCore {
  teamIds: string[];
  hostTeamId?: string;
  createdBy?: string;
  name: string;
  date: string;
  type: MeetDoc["type"];
  course: MeetDoc["course"];
  location?: string;
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
 * Break the model into objects.
 *
 * `progress` is deliberately left behind: where a device has scrolled to in
 * the running order is nobody else's business, and syncing it would put a
 * write on the wire every time someone taps an arrow.
 */
export function toObjects(
  teams: TeamDoc[],
  athletes: Athlete[],
  meets: MeetDoc[],
): SyncObject[] {
  const objects: SyncObject[] = [];

  for (const team of teams) {
    const at = team.updatedAt;
    const scope = teamScope(team.id);

    const core: TeamCore = {
      name: team.name,
      code: team.code,
      currentSeasonId: team.currentSeasonId,
    };
    objects.push({ id: team.id, type: "team", scope, updatedAt: at, data: core });

    for (const season of team.seasons) {
      objects.push({
        id: season.id,
        type: "season",
        scope,
        updatedAt: at,
        data: season,
      });
    }
    for (const enrollment of team.enrollments) {
      objects.push({
        id: enrollment.id,
        type: "enrollment",
        scope,
        updatedAt: at,
        data: enrollment,
      });
    }
  }

  // People belong to no team, so they're stamped with the moment they were
  // last touched by whatever document happened to be holding them.
  const athleteAt = teams[0]?.updatedAt ?? Date.now();
  for (const athlete of athletes) {
    objects.push({
      id: athlete.id,
      type: "athlete",
      scope: GLOBAL,
      updatedAt: athleteAt,
      data: athlete,
    });
  }

  for (const meet of meets) {
    objects.push(...meetObjects(meet));
  }

  return objects;
}

function meetObjects(meet: MeetDoc): SyncObject[] {
  const at = meet.updatedAt;
  const scope = meetScope(meet.id);
  const stamp = { scope, updatedAt: at };

  const core: MeetCore = {
    teamIds: meet.teamIds,
    hostTeamId: meet.hostTeamId,
    createdBy: meet.createdBy,
    name: meet.name,
    date: meet.date,
    type: meet.type,
    course: meet.course,
    location: meet.location,
    options: meet.options,
    timer: meet.deletedAt ? null : meet.timer,
  };

  // A deleted meet is one tombstone and nothing else — its parts went with it.
  if (meet.deletedAt) {
    return [
      { id: meet.id, type: "meet", ...stamp, deletedAt: meet.deletedAt, data: core },
    ];
  }

  const objects: SyncObject[] = [
    { id: meet.id, type: "meet", ...stamp, data: core },
    // The running order is one object: reordering is a statement about the
    // whole list, and merging two reorderings per-event would produce a
    // programme neither coach wrote.
    { id: meet.id, type: "lineup", ...stamp, data: { events: meet.events } },
  ];

  for (const [eventId, athleteIds] of Object.entries(meet.entries)) {
    for (const athleteId of athleteIds) {
      objects.push({
        id: entryId(meet.id, eventId, athleteId),
        type: "entry",
        ...stamp,
        data: { eventId, athleteId },
      });
    }
  }
  for (const heat of meet.heats) {
    objects.push({ id: heat.id, type: "heat", ...stamp, data: heat });
  }
  for (const watch of meet.watches) {
    objects.push({ id: watch.id, type: "watch", ...stamp, data: watch });
  }
  for (const ruling of meet.rulings) {
    objects.push({ id: ruling.id, type: "ruling", ...stamp, data: ruling });
  }

  return objects;
}

/* -------------------------------------------------------------- recomposing */

/**
 * Put the model back together from its objects.
 *
 * Anything whose parent is missing is dropped rather than guessed at: an
 * entry for a meet this device doesn't have is not information, it's noise.
 */
export function fromObjects(objects: SyncObject[]): {
  teams: TeamDoc[];
  athletes: Athlete[];
  meets: MeetDoc[];
} {
  const live = objects.filter((o) => !o.deletedAt);
  const of = <T,>(type: SyncObjectType): Array<SyncObject & { data: T }> =>
    live.filter((o) => o.type === type) as Array<SyncObject & { data: T }>;

  const scopedTo = (object: SyncObject): string =>
    object.scope.kind === "global" ? "" : object.scope.id;

  const byTeam = new Map<string, TeamDoc>();
  for (const object of of<TeamCore>("team")) {
    byTeam.set(object.id, {
      version: TEAM_DOC_VERSION,
      id: object.id,
      ...object.data,
      seasons: [],
      enrollments: [],
      updatedAt: object.updatedAt,
    });
  }
  for (const o of of<Season>("season")) {
    byTeam.get(scopedTo(o))?.seasons.push(o.data);
  }
  for (const o of of<Enrollment>("enrollment")) {
    byTeam.get(scopedTo(o))?.enrollments.push(o.data);
  }

  const athletes = of<Athlete>("athlete").map((o) => o.data);

  const byMeet = new Map<string, MeetDoc>();
  for (const object of of<MeetCore>("meet")) {
    byMeet.set(object.id, {
      version: MEET_DOC_VERSION,
      id: object.id,
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

  for (const o of of<{ events: MeetEvent[] }>("lineup")) {
    const meet = byMeet.get(scopedTo(o));
    if (meet) meet.events = o.data.events;
  }
  for (const o of of<{ eventId: string; athleteId: string }>("entry")) {
    const meet = byMeet.get(scopedTo(o));
    if (!meet) continue;
    (meet.entries[o.data.eventId] ??= []).push(o.data.athleteId);
  }
  for (const o of of<Heat>("heat")) {
    byMeet.get(scopedTo(o))?.heats.push(o.data);
  }
  for (const o of of<WatchTime>("watch")) {
    byMeet.get(scopedTo(o))?.watches.push(o.data);
  }
  for (const o of of<Ruling>("ruling")) {
    byMeet.get(scopedTo(o))?.rulings.push(o.data);
  }

  // Heats are read by index everywhere; entries and times are sets, but a
  // stable order keeps documents comparable.
  //
  // Seasons and enrollments are deliberately left in arrival order. Their ids
  // are random, so sorting on one would order them meaninglessly *and*
  // non-reproducibly — a round trip would hand back the same roster in a
  // different order every run.
  for (const meet of byMeet.values()) {
    meet.heats.sort((a, b) => a.eventId.localeCompare(b.eventId) || a.index - b.index);
    meet.watches.sort((a, b) => a.id.localeCompare(b.id));
    meet.rulings.sort((a, b) => a.id.localeCompare(b.id));
    for (const list of Object.values(meet.entries)) list.sort();
  }

  return {
    teams: [...byTeam.values()],
    athletes,
    meets: [...byMeet.values()],
  };
}

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

/**
 * An object's identity.
 *
 * Type and id, not scope: a meet moving between scopes would be a different
 * meet, and including the scope would make that look like a delete plus an
 * add rather than the bug it is.
 */
function key(object: SyncObject): string {
  return `${object.type}:${object.id}`;
}

function sameContent(a: SyncObject, b: SyncObject): boolean {
  return (
    (a.deletedAt ?? null) === (b.deletedAt ?? null) &&
    sameScope(a.scope, b.scope) &&
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

/* ---------------------------------------------------------------- selecting */

/**
 * The athletes a set of objects actually refers to.
 *
 * The participant projection: a device working one meet needs the people in
 * that meet's entries, heats and watches, and has no business holding anyone
 * else. `timerSnapshot` did this by hand for timers; it's the general rule.
 */
export function referencedAthletes(objects: SyncObject[]): Set<string> {
  const ids = new Set<string>();
  for (const object of objects) {
    if (object.deletedAt) continue;
    const data = object.data as Record<string, unknown>;
    switch (object.type) {
      case "entry":
      case "enrollment":
        if (typeof data.athleteId === "string") ids.add(data.athleteId);
        break;
      case "heat":
        for (const lane of (data.lanes as (string | null)[]) ?? []) {
          if (lane) ids.add(lane);
        }
        break;
      case "watch":
        if (typeof data.athleteId === "string") ids.add(data.athleteId);
        break;
    }
  }
  return ids;
}

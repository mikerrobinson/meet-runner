/**
 * What a timer's phone is allowed to know.
 *
 * Deliberately not the season. A device that scanned a QR code taped to a
 * timing table gets one meet's running order, the lanes, the names needed to
 * fill the picker, and its own times — and nothing else. No birth dates, no
 * other meets, no other timers' watches.
 *
 * The shape is the general one now: read a meet's scope, then the people those
 * objects refer to. `referencedAthletes` is the same rule any client uses to
 * work out which of the global roster it actually needs.
 */

import { ensureObjectStore } from "./sync.server";
import { referencedAthletes, type SyncObject } from "./objects";
import { seasonForDate } from "./roster";
import { todayIso } from "~/types/meet";
import type {
  Enrollment,
  Entries,
  Heat,
  MeetEvent,
  Season,
  TeamDoc,
  WatchTime,
} from "~/types/meet";
import type { Grant } from "./grants.server";

/** A team as a timer needs it: something to tap, and an id to send back. */
export interface TimerTeam {
  id: string;
  name: string;
}

/** A person as a timer needs them: a name, and who they swim for. */
export interface TimerAthlete {
  id: string;
  firstName: string;
  lastName: string;
  team?: string;
}

export interface TimerSnapshot {
  /** The server's clock, so six phones can be compared to one another later. */
  serverTime: number;
  expiresAt: number;
  meet: {
    id: string;
    name: string;
    date: string;
    laneCount: number;
    /** The teams racing, for the "add a swimmer" buttons. */
    teams: TimerTeam[];
  };
  /**
   * What to call athletes with no team of their own at this meet. The host
   * where there is one, so a timer standing at a home meet sees the home team
   * named rather than the word "Home".
   */
  ownTeam: string;
  /** In running order. */
  events: MeetEvent[];
  heats: Heat[];
  entries: Entries;
  athletes: TimerAthlete[];
  /** Only this device's own times. Another timer's is not a hint. */
  mine: WatchTime[];
}

interface Row {
  id: string;
  type: string;
  scope: string;
  data: string;
}

export async function timerSnapshot(
  db: D1Database,
  grant: Grant,
  timerId: string,
  now = Date.now(),
): Promise<TimerSnapshot | null> {
  await ensureObjectStore(db);

  const { results: meetRows } = await db
    .prepare(
      `SELECT id, type, scope, data FROM objects
       WHERE scope = ? AND deleted_at IS NULL`,
    )
    .bind(`meet:${grant.meetId}`)
    .all<Row>();

  const parsed = meetRows.map((row) => ({
    ...row,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
  const of = (type: string) => parsed.filter((row) => row.type === type);

  const core = of("meet")[0]?.data as
    | {
        name?: string;
        date?: string;
        teamIds?: string[];
        hostTeamId?: string;
        options?: { laneCount?: number };
      }
    | undefined;
  if (!core) return null;

  const lineup = of("lineup")[0]?.data as { events?: MeetEvent[] } | undefined;

  const entries: Entries = {};
  for (const row of of("entry")) {
    const entry = row.data as unknown as { eventId: string; athleteId: string };
    (entries[entry.eventId] ??= []).push(entry.athleteId);
  }

  const heats = of("heat").map((row) => row.data as unknown as Heat);
  heats.sort((a, b) => a.eventId.localeCompare(b.eventId) || a.index - b.index);

  const mine = of("watch")
    .map((row) => row.data as unknown as WatchTime)
    .filter((watch) => watch.timerId === timerId);

  // The teams racing, and the people they've enrolled. A timer needs both:
  // names to pick from, and short labels to group them under.
  const teamIds = core.teamIds ?? [];
  const teams = await teamsByCode(db, teamIds);
  const enrolledBy = await enrollmentsByTeam(db, teamIds);

  const teamOf = new Map<string, string>();
  for (const [teamId, athleteIds] of enrolledBy) {
    for (const athleteId of athleteIds) {
      if (!teamOf.has(athleteId)) teamOf.set(athleteId, teams.get(teamId) ?? "");
    }
  }

  // Everyone this meet refers to, plus everyone entered by a team racing it —
  // a swimmer nobody has seeded yet still has to be pickable.
  const wanted = new Set([
    ...referencedAthletes(
      meetRows.map(
        (row): SyncObject => ({
          id: row.id,
          type: row.type as SyncObject["type"],
          scope: { kind: "meet", id: grant.meetId },
          updatedAt: 0,
          data: JSON.parse(row.data),
        }),
      ),
    ),
    ...teamOf.keys(),
  ]);

  const athletes = await athletesByIds(db, [...wanted], teamOf);
  const host = core.hostTeamId ? teams.get(core.hostTeamId) : undefined;

  return {
    serverTime: now,
    expiresAt: grant.expiresAt,
    meet: {
      id: grant.meetId,
      name: core.name ?? "Meet",
      date: core.date ?? "",
      laneCount: core.options?.laneCount ?? 6,
      teams: teamIds
        .map((id) => ({ id, name: teams.get(id) ?? "" }))
        .filter((team) => team.name !== ""),
    },
    ownTeam: host || teams.get(teamIds[0] ?? "") || "Home",
    events: lineup?.events ?? [],
    heats,
    entries,
    athletes,
    mine,
  };
}

/**
 * Put a swimmer a timer typed in onto the roster of the team they named.
 *
 * The enrollment is minted *here*, from the meet's own facts, rather than
 * accepted from the phone. A timer may say "this is a Horizon swimmer"; they
 * may not say which team document to write into, or which season, and the
 * difference is what keeps a grant from reaching a team's roster generally.
 *
 * Returns null when the team isn't racing this meet, or has no season covering
 * its date — in which case the swimmer still gets recorded, just unaffiliated.
 */
export async function visitorEnrollment(
  db: D1Database,
  meetId: string,
  teamId: string,
  athleteId: string,
  now = Date.now(),
): Promise<SyncObject | null> {
  const { results } = await db
    .prepare(
      `SELECT id, type, data FROM objects
       WHERE deleted_at IS NULL
         AND ((type = 'meet' AND id = ?) OR (type IN ('team', 'season') AND scope = ?))`,
    )
    .bind(meetId, `team:${teamId}`)
    .all<{ id: string; type: string; data: string }>();

  const meetRow = results.find((row) => row.type === "meet");
  const teamRow = results.find((row) => row.type === "team");
  if (!meetRow || !teamRow) return null;

  const meet = JSON.parse(meetRow.data) as { teamIds?: string[]; date?: string };
  if (!meet.teamIds?.includes(teamId)) return null;

  const team = JSON.parse(teamRow.data) as { currentSeasonId?: string };
  const seasons = results
    .filter((row) => row.type === "season")
    .map((row) => JSON.parse(row.data) as Season);

  const season = seasonForDate(
    { seasons, currentSeasonId: team.currentSeasonId ?? "" } as TeamDoc,
    meet.date ?? todayIso(),
  );
  if (!season) return null;

  const enrollment: Enrollment = {
    // Derived, not generated: the same timer re-sending the same swimmer must
    // not enroll them twice.
    id: `${season.id}:${athleteId}`,
    teamId,
    seasonId: season.id,
    athleteId,
    year: "",
    status: "active",
  };

  return {
    id: enrollment.id,
    type: "enrollment",
    scope: { kind: "team", id: teamId },
    updatedAt: now,
    data: enrollment,
  };
}

/** Short labels for a set of teams, keyed by id. */
async function teamsByCode(
  db: D1Database,
  teamIds: string[],
): Promise<Map<string, string>> {
  if (teamIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT id, data FROM objects WHERE type = 'team' AND deleted_at IS NULL
         AND id IN (${teamIds.map(() => "?").join(", ")})`,
    )
    .bind(...teamIds)
    .all<{ id: string; data: string }>();

  return new Map(
    results.map((row) => {
      const team = JSON.parse(row.data) as { name?: string; code?: string };
      return [row.id, team.code || team.name || ""] as const;
    }),
  );
}

/** Who each team has enrolled, across every season — the picker wants names. */
async function enrollmentsByTeam(
  db: D1Database,
  teamIds: string[],
): Promise<Map<string, string[]>> {
  if (teamIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT scope, data FROM objects
       WHERE type = 'enrollment' AND deleted_at IS NULL
         AND scope IN (${teamIds.map(() => "?").join(", ")})`,
    )
    .bind(...teamIds.map((id) => `team:${id}`))
    .all<{ scope: string; data: string }>();

  const byTeam = new Map<string, string[]>();
  for (const row of results) {
    const teamId = row.scope.slice("team:".length);
    const enrollment = JSON.parse(row.data) as { athleteId?: string };
    if (!enrollment.athleteId) continue;
    (byTeam.get(teamId) ?? byTeam.set(teamId, []).get(teamId)!).push(
      enrollment.athleteId,
    );
  }
  return byTeam;
}

/**
 * Names for the picker. Selected fields only — a timer never receives a birth
 * date, which is the one thing on an athlete record worth guarding.
 */
async function athletesByIds(
  db: D1Database,
  ids: string[],
  teamOf: Map<string, string>,
): Promise<TimerAthlete[]> {
  if (ids.length === 0) return [];

  const athletes: TimerAthlete[] = [];
  for (let start = 0; start < ids.length; start += 40) {
    const slice = ids.slice(start, start + 40);
    const { results } = await db
      .prepare(
        `SELECT id, data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL
           AND id IN (${slice.map(() => "?").join(", ")})`,
      )
      .bind(...slice)
      .all<{ id: string; data: string }>();

    for (const row of results) {
      const athlete = JSON.parse(row.data) as TimerAthlete;
      athletes.push({
        id: athlete.id,
        firstName: athlete.firstName,
        lastName: athlete.lastName,
        team: teamOf.get(athlete.id) || undefined,
      });
    }
  }
  return athletes;
}

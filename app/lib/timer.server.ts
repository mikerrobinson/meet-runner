/**
 * What a timer's phone is allowed to know.
 *
 * Deliberately not the season. A device that scanned a QR code taped to a
 * timing table gets one meet's running order, the lanes, the names needed to
 * fill the picker, and its own times — and nothing else. No birth dates, no
 * other meets, no other timers' watches.
 *
 * This is assembled here rather than by letting timers into `/api/sync`
 * because that endpoint hands over a whole team, and a phone that only ever
 * writes times has no business holding one. It also means the timer client
 * needs no IndexedDB, no baseline and no cursor: it fetches a small JSON
 * document and posts times back.
 */

import { ensureObjectStore } from "./sync.server";
import type { Entries, Heat, MeetEvent, WatchTime } from "~/types/meet";
import type { Grant } from "./grants.server";

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
    /** Short labels for the teams racing, for the "add a swimmer" buttons. */
    teams: string[];
  };
  /**
   * What to call athletes who have no team label of their own — everyone on
   * the roster. Sent explicitly rather than guessed from the first entry in
   * `teams`, which is blank until a coach fills the field in.
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
  data: string;
}

export async function timerSnapshot(
  db: D1Database,
  grant: Grant,
  timerId: string,
  now = Date.now(),
): Promise<TimerSnapshot | null> {
  await ensureObjectStore(db);

  const [meetRows, athleteRows, teamRow] = await Promise.all([
    db
      .prepare(
        `SELECT id, type, data FROM objects
         WHERE meet_id = ? AND deleted_at IS NULL`,
      )
      .bind(grant.meetId)
      .all<Row>(),
    // Names for the picker. Selected columns only — a timer never receives a
    // birth date, which is the one thing on an athlete record worth guarding.
    db
      .prepare(
        `SELECT id, type, data FROM objects
         WHERE team_id = ? AND type = 'athlete' AND deleted_at IS NULL`,
      )
      .bind(grant.teamId)
      .all<Row>(),
    db
      .prepare(
        "SELECT data FROM objects WHERE type = 'team' AND id = ? AND deleted_at IS NULL",
      )
      .bind(grant.teamId)
      .first<{ data: string }>(),
  ]);

  const home = teamRow
    ? (JSON.parse(teamRow.data) as { name?: string; code?: string })
    : null;

  const parsed = meetRows.results.map((row) => ({
    ...row,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
  const of = (type: string) => parsed.filter((row) => row.type === type);

  const core = of("meet")[0]?.data as
    | { name?: string; date?: string; teams?: string[]; options?: { laneCount?: number } }
    | undefined;
  if (!core) return null;

  const lineup = of("lineup")[0]?.data as { events?: MeetEvent[] } | undefined;

  const entries: Entries = {};
  for (const row of of("entry")) {
    const entry = row.data as { eventId: string; athleteId: string };
    (entries[entry.eventId] ??= []).push(entry.athleteId);
  }

  const heats = of("heat").map((row) => {
    const { meetId, ...heat } = row.data as unknown as Heat & { meetId: string };
    return heat;
  });
  heats.sort((a, b) => a.eventId.localeCompare(b.eventId) || a.index - b.index);

  const mine = of("watch")
    .map((row) => {
      const { meetId, ...watch } = row.data as unknown as WatchTime & { meetId: string };
      return watch;
    })
    .filter((watch) => watch.timerId === timerId);

  const athletes: TimerAthlete[] = athleteRows.results.map((row) => {
    const athlete = JSON.parse(row.data) as TimerAthlete;
    return {
      id: athlete.id,
      firstName: athlete.firstName,
      lastName: athlete.lastName,
      team: athlete.team,
    };
  });

  return {
    serverTime: now,
    expiresAt: grant.expiresAt,
    meet: {
      id: grant.meetId,
      name: core.name ?? "Meet",
      date: core.date ?? "",
      laneCount: core.options?.laneCount ?? 6,
      teams: core.teams ?? [],
    },
    ownTeam: home?.code || home?.name || "Home",
    events: lineup?.events ?? [],
    heats,
    entries,
    athletes,
    mine,
  };
}

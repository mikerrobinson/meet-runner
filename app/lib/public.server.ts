/**
 * Reading the object store for anyone who asks.
 *
 * The browsing half of the app. Sync exists to keep a pool deck working with
 * no signal; this exists so a parent can open a link and see the results. They
 * read the same objects and share no code path beyond that, which is the point
 * — the sync engine stopped having to grow an opinion about who may read what.
 *
 * Rows come back through `fromObjects`, the same recomposition the client uses,
 * so there is one definition of what a meet is rather than a second one written
 * in SQL. Shaping and redaction then happen in `public.ts`, which is pure.
 */

import { ensureObjectStore } from "./sync.server";
import { fromObjects, scopeKey, type ObjectScope, type SyncObject } from "./objects";
import { teamForAthleteAt } from "./roster";
import {
  athleteSwims,
  meetResults,
  meetSummary,
  publicAthlete,
  publicAthletes,
  teamRef,
  type PublicAthlete,
  type PublicAthleteDetail,
  type PublicMeetDetail,
  type PublicMeetSummary,
  type PublicTeam,
  type TeamRef,
} from "./public";
import type { Athlete, MeetDoc, TeamDoc } from "~/types/meet";

interface Row {
  id: string;
  type: string;
  scope: string;
  updated_at: number;
  deleted_at: number | null;
  data: string;
}

function toSyncObject(row: Row): SyncObject {
  const [kind, ...rest] = row.scope.split(":");
  const id = rest.join(":");
  return {
    id: row.id,
    type: row.type as SyncObject["type"],
    scope:
      row.scope === "global"
        ? { kind: "global" }
        : kind === "meet"
          ? { kind: "meet", id }
          : { kind: "team", id },
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    data: JSON.parse(row.data),
  };
}

/** Everything in a set of scopes, recomposed into documents. */
async function readScopes(
  db: D1Database,
  scopes: ObjectScope[],
): Promise<{ teams: TeamDoc[]; athletes: Athlete[]; meets: MeetDoc[] }> {
  const keys = [...new Set(scopes.map(scopeKey))];
  if (keys.length === 0) return { teams: [], athletes: [], meets: [] };

  const { results } = await db
    .prepare(
      `SELECT id, type, scope, updated_at, deleted_at, data FROM objects
       WHERE scope IN (${keys.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
    )
    .bind(...keys)
    .all<Row>();

  return fromObjects(results.map(toSyncObject));
}

/** Athletes by id, in one round trip per batch. */
async function readAthletes(
  db: D1Database,
  ids: string[],
): Promise<Athlete[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];

  const found: Athlete[] = [];
  for (let start = 0; start < wanted.length; start += 40) {
    const slice = wanted.slice(start, start + 40);
    const { results } = await db
      .prepare(
        `SELECT data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL
           AND id IN (${slice.map(() => "?").join(", ")})`,
      )
      .bind(...slice)
      .all<{ data: string }>();
    found.push(...results.map((row) => JSON.parse(row.data) as Athlete));
  }
  return found;
}

/** Which teams have somebody signed in as a coach. */
async function claimedTeamIds(db: D1Database): Promise<Set<string>> {
  try {
    const { results } = await db
      .prepare(
        "SELECT DISTINCT team_id FROM memberships WHERE status = 'active'",
      )
      .all<{ team_id: string }>();
    return new Set(results.map((row) => row.team_id));
  } catch {
    // No memberships table yet — nobody has ever signed in, so nothing is
    // claimed. A fresh deployment should still be able to list its teams.
    return new Set();
  }
}

/* ------------------------------------------------------------------- teams */

export async function listPublicTeams(db: D1Database): Promise<PublicTeam[]> {
  await ensureObjectStore(db);

  const { results } = await db
    .prepare(
      `SELECT id, type, scope, data FROM objects
       WHERE deleted_at IS NULL AND type IN ('team', 'enrollment', 'meet', 'watch')`,
    )
    .all<{ id: string; type: string; scope: string; data: string }>();

  const claimed = await claimedTeamIds(db);
  const teams = new Map<string, PublicTeam>();
  const enrolled = new Map<string, Set<string>>();
  const meetTeams = new Map<string, string[]>();
  const watchesPerMeet = new Map<string, number>();

  for (const row of results) {
    if (row.type !== "team") continue;
    const data = JSON.parse(row.data) as { name?: string; code?: string };
    teams.set(row.id, {
      id: row.id,
      name: data.name ?? "Untitled team",
      code: data.code ?? "",
      claimed: claimed.has(row.id),
      athletes: 0,
      meets: 0,
      times: 0,
    });
  }

  for (const row of results) {
    if (row.type === "enrollment" && row.scope.startsWith("team:")) {
      const teamId = row.scope.slice("team:".length);
      const data = JSON.parse(row.data) as { athleteId?: string };
      if (!data.athleteId) continue;
      let people = enrolled.get(teamId);
      if (!people) enrolled.set(teamId, (people = new Set()));
      people.add(data.athleteId);
    } else if (row.type === "meet") {
      const data = JSON.parse(row.data) as { teamIds?: string[] };
      meetTeams.set(row.id, data.teamIds ?? []);
      for (const teamId of data.teamIds ?? []) {
        const team = teams.get(teamId);
        if (team) team.meets += 1;
      }
    } else if (row.type === "watch" && row.scope.startsWith("meet:")) {
      const meetId = row.scope.slice("meet:".length);
      watchesPerMeet.set(meetId, (watchesPerMeet.get(meetId) ?? 0) + 1);
    }
  }

  for (const [teamId, people] of enrolled) {
    const team = teams.get(teamId);
    if (team) team.athletes = people.size;
  }

  // A meet's times count for every team racing it, since both were there.
  for (const [meetId, teamIds] of meetTeams) {
    const times = watchesPerMeet.get(meetId) ?? 0;
    for (const teamId of teamIds) {
      const team = teams.get(teamId);
      if (team) team.times += times;
    }
  }

  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `meets` is a list here and a count on `PublicTeam`, so the count is dropped
 * rather than shadowed — two fields of the same name meaning different things
 * is how a template ends up printing "[object Object] meets".
 */
export interface PublicTeamDetail extends Omit<PublicTeam, "meets"> {
  seasons: Array<{
    id: string;
    name: string;
    startDate?: string;
    endDate?: string;
    roster: Array<PublicAthlete & { year: string; squad?: string; active: boolean }>;
  }>;
  meets: PublicMeetSummary[];
}

export async function publicTeamDetail(
  db: D1Database,
  teamId: string,
): Promise<PublicTeamDetail | null> {
  await ensureObjectStore(db);

  const { teams } = await readScopes(db, [{ kind: "team", id: teamId }]);
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;

  const people = await readAthletes(
    db,
    team.enrollments.map((e) => e.athleteId),
  );
  const byId = new Map(people.map((a) => [a.id, a] as const));
  const claimed = await claimedTeamIds(db);

  const seasons = [...team.seasons]
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""))
    .map((season) => ({
      id: season.id,
      name: season.name,
      startDate: season.startDate,
      endDate: season.endDate,
      roster: team.enrollments
        .filter((e) => e.seasonId === season.id && byId.has(e.athleteId))
        .map((e) => ({
          ...publicAthlete(byId.get(e.athleteId)!),
          year: e.year,
          squad: e.squad,
          active: e.status === "active",
        }))
        .sort(
          (a, b) =>
            a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName),
        ),
    }));

  const meets = await listPublicMeets(db, { teamId });

  return {
    id: team.id,
    name: team.name,
    code: team.code,
    claimed: claimed.has(team.id),
    athletes: new Set(team.enrollments.map((e) => e.athleteId)).size,
    times: meets.reduce((total, meet) => total + meet.times, 0),
    seasons,
    meets,
  };
}

/* ------------------------------------------------------------------- meets */

/** Every meet, newest first. Optionally only those one team is racing. */
export async function listPublicMeets(
  db: D1Database,
  options: { teamId?: string } = {},
): Promise<PublicMeetSummary[]> {
  await ensureObjectStore(db);

  const { results } = await db
    .prepare(
      `SELECT id, type, scope, updated_at, deleted_at, data FROM objects
       WHERE deleted_at IS NULL
         AND type IN ('meet', 'lineup', 'entry', 'watch', 'ruling', 'team')`,
    )
    .all<Row>();

  const { teams, meets } = fromObjects(results.map(toSyncObject));

  return meets
    .filter((meet) => !options.teamId || meet.teamIds.includes(options.teamId))
    .map((meet) => meetSummary(meet, teams))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

export async function publicMeetDetail(
  db: D1Database,
  meetId: string,
): Promise<PublicMeetDetail | null> {
  await ensureObjectStore(db);

  const { meets } = await readScopes(db, [{ kind: "meet", id: meetId }]);
  const meet = meets.find((m) => m.id === meetId);
  if (!meet) return null;

  const { teams } = await readScopes(
    db,
    meet.teamIds.map((id): ObjectScope => ({ kind: "team", id })),
  );

  // Everyone the meet refers to, plus everyone its teams enrolled — a heat
  // sheet names people who haven't swum yet.
  const referenced = new Set<string>();
  for (const list of Object.values(meet.entries)) {
    for (const id of list) referenced.add(id);
  }
  for (const heat of meet.heats) {
    for (const lane of heat.lanes) if (lane) referenced.add(lane);
  }
  for (const watch of meet.watches) {
    if (watch.athleteId) referenced.add(watch.athleteId);
  }
  for (const team of teams) {
    for (const enrollment of team.enrollments) referenced.add(enrollment.athleteId);
  }

  const athletes = await readAthletes(db, [...referenced]);
  const teamOf = (athleteId: string): TeamRef | null => {
    const team = teamForAthleteAt(teams, meet, athleteId);
    return team ? teamRef(team) : null;
  };

  return {
    ...meetSummary(meet, teams),
    results: meetResults(meet, athletes, teamOf),
  };
}

/* ---------------------------------------------------------------- athletes */

export async function listPublicAthletes(
  db: D1Database,
  options: { q?: string; limit?: number } = {},
): Promise<Array<PublicAthlete & { teams: TeamRef[] }>> {
  await ensureObjectStore(db);

  const { results } = await db
    .prepare(
      `SELECT id, type, scope, data FROM objects
       WHERE deleted_at IS NULL AND type IN ('athlete', 'enrollment', 'team')`,
    )
    .all<{ id: string; type: string; scope: string; data: string }>();

  const teams = new Map<string, TeamRef>();
  const people: Athlete[] = [];
  const teamsOf = new Map<string, Set<string>>();

  for (const row of results) {
    if (row.type === "team") {
      const data = JSON.parse(row.data) as { name?: string; code?: string };
      teams.set(row.id, {
        id: row.id,
        name: data.name ?? "Untitled team",
        code: data.code ?? "",
      });
    } else if (row.type === "athlete") {
      people.push(JSON.parse(row.data) as Athlete);
    }
  }

  for (const row of results) {
    if (row.type !== "enrollment" || !row.scope.startsWith("team:")) continue;
    const teamId = row.scope.slice("team:".length);
    const data = JSON.parse(row.data) as { athleteId?: string };
    if (!data.athleteId) continue;
    let list = teamsOf.get(data.athleteId);
    if (!list) teamsOf.set(data.athleteId, (list = new Set()));
    list.add(teamId);
  }

  const needle = options.q?.trim().toLowerCase();
  return publicAthletes(people)
    .filter(
      (a) =>
        !needle ||
        `${a.firstName} ${a.lastName}`.toLowerCase().includes(needle),
    )
    .map((a) => ({
      ...a,
      teams: [...(teamsOf.get(a.id) ?? [])]
        .map((id) => teams.get(id))
        .filter((t): t is TeamRef => t !== undefined),
    }))
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName),
    )
    .slice(0, options.limit ?? 500);
}

export async function publicAthleteDetail(
  db: D1Database,
  athleteId: string,
): Promise<PublicAthleteDetail | null> {
  await ensureObjectStore(db);

  const [athlete] = await readAthletes(db, [athleteId]);
  if (!athlete) return null;

  // Which teams have ever enrolled them, and in which seasons.
  const { results: enrollments } = await db
    .prepare(
      `SELECT scope, data FROM objects
       WHERE type = 'enrollment' AND deleted_at IS NULL`,
    )
    .all<{ scope: string; data: string }>();

  const teamIds = new Set<string>();
  const seasonIds = new Map<string, string[]>();
  for (const row of enrollments) {
    const data = JSON.parse(row.data) as { athleteId?: string; seasonId?: string };
    if (data.athleteId !== athleteId || !row.scope.startsWith("team:")) continue;
    const teamId = row.scope.slice("team:".length);
    teamIds.add(teamId);
    if (data.seasonId) {
      (seasonIds.get(teamId) ?? seasonIds.set(teamId, []).get(teamId)!).push(
        data.seasonId,
      );
    }
  }

  const { teams } = await readScopes(
    db,
    [...teamIds].map((id): ObjectScope => ({ kind: "team", id })),
  );

  // Every meet those teams raced — that's where this person's swims can be.
  const meetSummaries = await listPublicMeets(db);
  const theirMeetIds = meetSummaries
    .filter((summary) => summary.teams.some((t) => teamIds.has(t.id)))
    .map((summary) => summary.id);

  const { meets } = await readScopes(
    db,
    theirMeetIds.map((id): ObjectScope => ({ kind: "meet", id })),
  );

  return {
    ...publicAthlete(athlete),
    teams: teams.map((team) => ({
      ...teamRef(team),
      seasons: team.seasons
        .filter((s) => seasonIds.get(team.id)?.includes(s.id))
        .map((s) => s.name),
    })),
    swims: athleteSwims(athleteId, meets),
  };
}

/* ------------------------------------------------------------------- users */

export interface UserDashboard {
  userId: string;
  name: string | null;
  teams: Array<TeamRef & { role: string; status: string }>;
  meets: PublicMeetSummary[];
  /** The athlete record this account is, when one has been linked. */
  athlete: PublicAthlete | null;
}

export async function userDashboard(
  db: D1Database,
  userId: string,
): Promise<UserDashboard | null> {
  await ensureObjectStore(db);

  const user = await db
    .prepare("SELECT id, name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; name: string | null }>();
  if (!user) return null;

  const { results: memberships } = await db
    .prepare(
      "SELECT team_id, role, status FROM memberships WHERE user_id = ?",
    )
    .bind(userId)
    .all<{ team_id: string; role: string; status: string }>();

  const { teams } = await readScopes(
    db,
    memberships.map((m): ObjectScope => ({ kind: "team", id: m.team_id })),
  );

  const allMeets = await listPublicMeets(db);
  const mine = new Set(memberships.map((m) => m.team_id));

  // The athlete record this account is, if a coach has linked one.
  const { results: linked } = await db
    .prepare(
      "SELECT data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL",
    )
    .all<{ data: string }>();
  const athlete = linked
    .map((row) => JSON.parse(row.data) as Athlete)
    .find((a) => a.userId === userId);

  return {
    userId: user.id,
    name: user.name,
    teams: memberships.flatMap((m) => {
      const team = teams.find((t) => t.id === m.team_id);
      return team
        ? [{ ...teamRef(team), role: m.role, status: m.status }]
        : [];
    }),
    meets: allMeets.filter((meet) => meet.teams.some((t) => mine.has(t.id))),
    athlete: athlete ? publicAthlete(athlete) : null,
  };
}

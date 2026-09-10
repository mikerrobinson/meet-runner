import type { Route } from "./+types/api.sync";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { canUseTeam, membershipIn } from "~/lib/auth.server";
import { isCoach } from "~/lib/identity";
import {
  administeredMeets,
  claimUnadministeredMeet,
  meetsAdministeredBy,
} from "~/lib/admins.server";
import {
  ensureObjectStore,
  meetIdsFor,
  pullObjects,
  pushObjects,
} from "~/lib/sync.server";
import type { ObjectScope, SyncObject } from "~/lib/objects";

/**
 * One endpoint for the whole exchange: send what changed, get back what
 * changed elsewhere.
 *
 *   POST { teamId, cursor, changes[] } -> { cursor, changes[], more, refused[] }
 *
 * Pushing and pulling in one round trip is what makes this usable on pool
 * wifi, where the cost is the round trip rather than the bytes.
 *
 * The caller names one team; the server works out what that entitles them to
 * read and write. That's `team:{id}`, every meet the team is racing, and the
 * global people those reference — never another team's roster.
 *
 * Reading and writing are not the same permission, and inside a meet the
 * question isn't which team you're from — it's whether you're running it.
 *
 *   meet admin   the meet, its lineup, its heats, and every ruling
 *   coach        their own team, their own swimmers' entries, and watches
 *   athlete      entering and scratching themselves
 *
 * Watches and rulings sit on opposite sides of that line deliberately. A watch
 * is evidence: several per lane, resolved by median, and one more never
 * overwrites anybody — so every coach keeps their stopwatch. A ruling is a
 * decision, and at a meet with two schools in the water the decision isn't one
 * of the schools' to make.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    if (request.method !== "POST") {
      throw new SyncError("Use POST to sync", 405);
    }

    const body = (await request.json().catch(() => null)) as {
      teamId?: string;
      cursor?: string;
      changes?: SyncObject[];
    } | null;

    if (!body?.teamId) throw new SyncError("Which team?", 400);

    const db = requireDb(env);
    const teamId = body.teamId;
    const changes = body.changes ?? [];

    const user = await currentUser(request, env);
    const allowed = await canUseTeam(db, user?.id ?? null, teamId);
    if (!allowed.ok) throw new SyncError(allowed.reason, 403);

    // What this particular person may change, as opposed to see.
    const membership = user ? await membershipIn(db, user.id, teamId) : undefined;
    const coach = !user || (membership ? isCoach(membership.role) : false);
    const ownAthleteId = coach || !user ? null : await athleteFor(db, user.id);
    const adminOf = await meetsAdministeredBy(db, user?.id);
    // An unauthenticated caller only gets here when the deployment has no
    // SYNC_TOKEN and no accounts at all — a single-coach install, where there
    // is nobody to be an administrator *other* than whoever is holding it.
    const anonymous = !user;

    const meetIds = new Set(await meetIdsFor(db, teamId));

    // A meet being created right now isn't in the store yet, so its own object
    // is what authorises the rest of the batch. Without this, setting up a meet
    // and seeding it in one sync would have the seeding refused.
    for (const object of changes) {
      if (object.type !== "meet") continue;
      const meet = object.data as { teamIds?: string[] } | null;
      if (meet?.teamIds?.includes(teamId)) meetIds.add(object.id);
    }

    const refusedScope = changes.find(
      (object) => !mayWrite(object, teamId, meetIds),
    );
    if (refusedScope) {
      throw new SyncError(
        "That batch reaches outside this team's meets and roster",
        400,
      );
    }

    if (!coach) {
      const refusedRole = changes.find(
        (object) => !mayWriteAsAthlete(object, ownAthleteId),
      );
      if (refusedRole) {
        throw new SyncError(
          ownAthleteId
            ? "You can enter and scratch yourself; the rest is the coach's."
            : "Only a coach can change this. Ask yours to link your account to your roster entry.",
          403,
        );
      }
    } else if (!anonymous) {
      const ourAthletes = await athletesEnrolledBy(db, teamId);
      // A meet nobody runs yet is open — whoever pushes it takes it on, a few
      // lines below. Without this the first push is refused for not being an
      // administrator the meet doesn't have.
      const spokenFor = await administeredMeets(db, [
        ...new Set(
          changes
            .filter((object) => object.scope.kind === "meet")
            .map((object) => (object.scope as { id: string }).id),
        ),
      ]);
      const refusedAdmin = changes.find(
        (object) => !mayWriteAsCoach(object, adminOf, spokenFor, ourAthletes),
      );
      if (refusedAdmin) {
        throw new SyncError(
          refusedAdmin.type === "entry"
            ? "That swimmer isn't on your roster."
            : "Whoever is running this meet decides that. You can still record times.",
          403,
        );
      }
    }

    const pushed = await pushObjects(db, changes);

    // A meet nobody administrates goes to whoever just put it on the server.
    for (const object of changes) {
      if (object.type !== "meet" || object.deletedAt) continue;
      await claimUnadministeredMeet(db, object.id, user?.id);
    }
    const pulled = await pullObjects(
      db,
      [
        { kind: "team", id: teamId },
        ...[...meetIds].map((id): ObjectScope => ({ kind: "meet", id })),
        // People are global and public. Only the ones that actually changed
        // come back, so this stays near-empty once a roster has settled.
        { kind: "global" },
      ],
      body.cursor,
    );

    return json({
      cursor: pulled.cursor,
      changes: pulled.changes,
      more: pulled.more,
      applied: pushed.applied,
      refused: pushed.refused,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Whether a member of this team may write an object at all.
 *
 * Scope is the whole check: a team's own data, a meet it's actually racing, or
 * a person. Which *parts* a member may change is the app's business, not this
 * endpoint's — but reaching into a team they don't belong to is not.
 */
function mayWrite(
  object: SyncObject,
  teamId: string,
  meetIds: Set<string>,
): boolean {
  switch (object.scope.kind) {
    case "team":
      return object.scope.id === teamId;
    case "meet":
      return meetIds.has(object.scope.id);
    case "global":
      return object.type === "athlete";
  }
}

/**
 * The roster entry an account is, if a coach has linked one.
 *
 * Read from the objects rather than trusted from the request: which swimmer
 * you are is a claim only a coach gets to make.
 */
async function athleteFor(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  await ensureObjectStore(db);
  const { results } = await db
    .prepare(
      "SELECT id, data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL",
    )
    .all<{ id: string; data: string }>();

  const mine = results.find(
    (row) => (JSON.parse(row.data) as { userId?: string }).userId === userId,
  );
  return mine ? mine.id : null;
}

/**
 * What somebody who isn't a coach may write.
 *
 * Their own entries, and nothing else. Not heats — seeding is the coach's
 * call. Not watches — a swimmer doesn't time their own race. Not the athlete
 * record, because editing the name on it is how you'd quietly become someone
 * else.
 */
function mayWriteAsAthlete(
  object: SyncObject,
  ownAthleteId: string | null,
): boolean {
  if (!ownAthleteId) return false;
  if (object.type !== "entry") return false;
  const entry = object.data as { athleteId?: string } | null;
  return entry?.athleteId === ownAthleteId;
}

/** Athlete ids a team has enrolled, in any season. */
async function athletesEnrolledBy(
  db: D1Database,
  teamId: string,
): Promise<Set<string>> {
  await ensureObjectStore(db);
  const { results } = await db
    .prepare(
      `SELECT data FROM objects
       WHERE type = 'enrollment' AND scope = ? AND deleted_at IS NULL`,
    )
    .bind(`team:${teamId}`)
    .all<{ data: string }>();

  const ids = new Set<string>();
  for (const row of results) {
    const enrollment = JSON.parse(row.data) as { athleteId?: string };
    if (enrollment.athleteId) ids.add(enrollment.athleteId);
  }
  return ids;
}

/**
 * What a coach may write in a meet they don't run.
 *
 * Their own team's data outright; inside the meet, their own swimmers' entries
 * and any watch. Everything that decides how the meet goes — the running
 * order, the seeding, the rulings, the meet's own details — belongs to whoever
 * is administrating it, and a coach who *is* administrating passes this
 * trivially because the meet is in `adminOf`.
 */
function mayWriteAsCoach(
  object: SyncObject,
  adminOf: Set<string>,
  spokenFor: Set<string>,
  ourAthletes: Set<string>,
): boolean {
  // A team's own data, and people, are not meet business.
  if (object.scope.kind === "team" || object.scope.kind === "global") return true;
  if (adminOf.has(object.scope.id)) return true;
  // Nobody runs it yet, so this push is the one that claims it.
  if (!spokenFor.has(object.scope.id)) return true;

  // A watch is evidence, and an extra one never overwrites anybody.
  if (object.type === "watch") return true;

  if (object.type === "entry") {
    const entry = object.data as { athleteId?: string } | null;
    return entry?.athleteId ? ourAthletes.has(entry.athleteId) : false;
  }

  return false;
}

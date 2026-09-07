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
 * Reading and writing are not the same permission. Everyone on the team reads
 * the same set; only a coach may write most of it. An athlete may enter and
 * scratch *themselves* and nothing else — which is the original reason this
 * app exists, iPads handed round before a meet, and is also as far as it goes:
 * before this check, admitting a swimmer handed them the whole season.
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
    }

    const pushed = await pushObjects(db, changes);
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

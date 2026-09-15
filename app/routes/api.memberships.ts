import type { Route } from "./+types/api.memberships";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import {
  claimNewTeam,
  decideRequest,
  membershipIn,
  removeMember,
  requestToJoin,
  sessionPayload,
} from "~/lib/auth.server";
import { ROLES, canAdmit, type Role } from "~/lib/identity";

/**
 * Changing who's on a team.
 *
 *   POST   { teamId } -> the session, updated    (ask to join)
 *   PATCH  { teamId, userId, admit, role }       (coaches only)
 *   DELETE { teamId, userId }                    (a coach, or yourself)
 *
 * Writes only. Reading who's on a team — its coaches and the people waiting —
 * is `GET /api/teams/:teamId/coaches`, in one answer, so there is one place
 * that says what a team's roll is.
 */

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson<{
      teamId?: string;
      userId?: string;
      admit?: boolean;
      role?: string;
      create?: boolean;
      name?: string;
    }>(request);
    if (!body.teamId) throw new SyncError("Which team?", 400);

    if (request.method === "POST") {
      // `create` is a device saying "this id is a team I just made", which is
      // a different question from "let me into that one".
      const result = body.create
        ? await claimNewTeam(db, user.id, body.teamId, { name: body.name })
        : await requestToJoin(db, user.id, body.teamId);
      if (!result.ok) throw new SyncError(result.error, 409);
      return json({
        claimed: result.claimed,
        ...(await sessionPayload(db, await requireUser(request, env), body.teamId)),
      });
    }

    // Everything below is a coach acting on somebody else — except leaving,
    // which is the one thing you're always allowed to do to yourself.
    const leaving =
      request.method === "DELETE" && (!body.userId || body.userId === user.id);
    if (!leaving && !canAdmit(await membershipIn(db, user.id, body.teamId))) {
      throw new SyncError("Only a coach can do that", 403);
    }

    if (request.method === "DELETE") {
      await removeMember(db, body.teamId, body.userId ?? user.id);
    } else if (request.method === "PATCH") {
      if (!body.userId) throw new SyncError("Which person?", 400);
      const role = body.role as Role | undefined;
      if (role && !ROLES.includes(role)) throw new SyncError("Unknown role", 400);
      await decideRequest(db, body.teamId, body.userId, {
        admit: body.admit !== false,
        role,
        by: user.id,
      });
    } else {
      throw new SyncError("Use POST, PATCH or DELETE", 405);
    }

    return json(await sessionPayload(db, await requireUser(request, env)));
  } catch (error) {
    return errorResponse(error);
  }
}

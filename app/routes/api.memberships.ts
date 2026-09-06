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
  pendingRequests,
  removeMember,
  requestToJoin,
  sessionPayload,
} from "~/lib/auth.server";
import { ROLES, canAdmit, type Role } from "~/lib/identity";

/**
 * Who's on a team, and who wants to be.
 *
 *   GET    ?teamId=  -> { pending }              (coaches only)
 *   POST   { teamId } -> the session, updated    (ask to join)
 *   PATCH  { teamId, userId, admit, role }       (coaches only)
 *   DELETE { teamId, userId }                    (a coach, or yourself)
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const teamId = new URL(request.url).searchParams.get("teamId");
    if (!teamId) throw new SyncError("Which team?", 400);

    if (!canAdmit(await membershipIn(db, user.id, teamId))) {
      throw new SyncError("Only a coach can see who's waiting to join", 403);
    }
    return json({ pending: await pendingRequests(db, teamId) });
  } catch (error) {
    return errorResponse(error);
  }
}

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
    }>(request);
    if (!body.teamId) throw new SyncError("Which team?", 400);

    if (request.method === "POST") {
      // `create` is a device saying "this id is a team I just made", which is
      // a different question from "let me into that one".
      const result = body.create
        ? await claimNewTeam(db, user.id, body.teamId)
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

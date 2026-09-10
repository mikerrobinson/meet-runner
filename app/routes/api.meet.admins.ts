import type { Route } from "./+types/api.meet.admins";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { currentUser } from "~/lib/api.server";
import {
  addMeetAdmin,
  isMeetAdmin,
  meetAdmins,
  removeMeetAdmin,
} from "~/lib/admins.server";

/**
 * Who runs a meet.
 *
 *   GET    /api/meets/:meetId/admins            -> the list
 *   POST   /api/meets/:meetId/admins { userId } -> hand the job to someone
 *   DELETE /api/meets/:meetId/admins { userId } -> take it back, or step down
 *
 * Only an administrator may add or remove one, which makes this the same shape
 * as every other "who's in charge" question in the app: you can't appoint
 * yourself, somebody already trusted has to do it.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    return json({
      admins: await meetAdmins(db, params.meetId),
      // So a screen can show the controls without a second round trip.
      youRunThis: await isMeetAdmin(db, user?.id, params.meetId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);

    if (!(await isMeetAdmin(db, user.id, params.meetId))) {
      throw new SyncError("Only someone running this meet can change that", 403);
    }

    const body = await readJson<{ userId?: string }>(request);
    if (!body.userId) throw new SyncError("Which person?", 400);

    if (request.method === "DELETE") {
      const result = await removeMeetAdmin(db, params.meetId, body.userId);
      if (!result.ok) throw new SyncError(result.reason, 400);
    } else if (request.method === "POST") {
      await addMeetAdmin(db, params.meetId, body.userId, user.id);
    } else {
      throw new SyncError("Use POST or DELETE", 405);
    }

    return json({ admins: await meetAdmins(db, params.meetId) });
  } catch (error) {
    return errorResponse(error);
  }
}

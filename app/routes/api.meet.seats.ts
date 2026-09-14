import type { Route } from "./+types/api.meet.seats";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { meetAccess, mayRecordTime } from "~/lib/access.server";
import { clearSeat, setSeat } from "~/lib/meets.server";

/**
 * Who is in a lane.
 *
 *   POST   { heatId, lane, athleteId } -> seat them
 *   DELETE { heatId, lane }            -> empty the lane
 *
 * Open to anyone who may record a time, not just to whoever runs the meet.
 * Names get sorted out behind the blocks by the person standing there, and a
 * correction that has to wait for the desk is a correction that arrives after
 * the race. The row is keyed by lane, so the last person to decide wins and
 * six timers seating their own lane never collide.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    if (!mayRecordTime(access)) {
      throw new SyncError("Only the teams racing can change the lanes.", 403);
    }

    const body = await readJson<{
      heatId?: string;
      lane?: number;
      athleteId?: string;
    }>(request);
    const lane = Number(body.lane);
    if (!body.heatId || !Number.isFinite(lane) || lane < 1) {
      throw new SyncError("Which lane?", 400);
    }

    if (request.method === "DELETE") {
      await clearSeat(db, body.heatId, lane);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);
    if (!body.athleteId) throw new SyncError("Which swimmer?", 400);

    await setSeat(db, params.meetId, {
      heatId: body.heatId,
      lane,
      athleteId: body.athleteId,
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

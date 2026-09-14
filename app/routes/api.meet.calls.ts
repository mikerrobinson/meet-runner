import type { Route } from "./+types/api.meet.calls";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { meetAccess, mayDecide } from "~/lib/access.server";
import { deleteCall, meetDetail, putCall } from "~/lib/meets.server";
import { makeCall } from "~/lib/timing";
import type { ResultStatus } from "~/types/meet";

/**
 * Deciding a lane.
 *
 *   POST   { heatId, lane, status?, timeMs?, athleteId?, final? }
 *   DELETE { heatId, lane }
 *
 * Administrators only, which is the other half of the line watches sit on: an
 * extra watch never overwrites anybody, but with two schools in the water a DQ
 * isn't one school's call to make.
 *
 * The patch is folded onto whatever call already exists, so marking a DQ keeps
 * a time that was typed and typing a time keeps a DQ. Two fields of one
 * decision, and neither erases the other.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    if (!mayDecide(access)) {
      throw new SyncError("Whoever is running this meet decides that.", 403);
    }

    const body = await readJson<{
      heatId?: string;
      lane?: number;
      status?: ResultStatus;
      timeMs?: number | null;
      athleteId?: string | null;
      final?: boolean;
    }>(request);
    const lane = Number(body.lane);
    if (!body.heatId || !Number.isFinite(lane) || lane < 1) {
      throw new SyncError("Which lane?", 400);
    }

    if (request.method === "DELETE") {
      await deleteCall(db, body.heatId, lane);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const detail = await meetDetail(db, params.meetId);
    const heat = detail?.heats.find((h) => h.id === body.heatId);
    if (!detail || !heat) throw new SyncError("No such heat", 404);

    await putCall(
      db,
      params.meetId,
      makeCall(
        detail,
        heat,
        lane,
        {
          status: body.status,
          timeMs: body.timeMs,
          athleteId: body.athleteId,
          final: body.final,
        },
        user?.id,
      ),
    );
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

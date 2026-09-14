import type { Route } from "./+types/api.meet.watches";
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
import { clearOwnWatches, deleteWatch, putWatch } from "~/lib/meets.server";

/**
 * Times off a stopwatch.
 *
 *   POST   { heatId, lane, timerId, timeMs, ... } -> record
 *   DELETE { heatId, lane, timerId }              -> drop that one watch
 *   DELETE { heatId, timerId }                    -> drop that device's watches
 *
 * A watch is evidence, and there is one row per timer per lane, so recording
 * one never overwrites anybody. That is also why this is open to every coach
 * of a racing team rather than to the administrator alone.
 *
 * The bulk delete is scoped to a single `timerId` on purpose: a device may
 * throw away its own evidence — a false start, starting a heat again — and may
 * not throw away anyone else's, which is a decision and belongs at the desk.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    if (!mayRecordTime(access)) {
      throw new SyncError("Only the teams racing can record times.", 403);
    }

    const body = await readJson<{
      heatId?: string;
      lane?: number;
      timerId?: string;
      timeMs?: number;
      source?: string;
      recordedAt?: number;
      startedAt?: number;
      stoppedAt?: number;
    }>(request);
    if (!body.heatId || !body.timerId) throw new SyncError("Which watch?", 400);

    if (request.method === "DELETE") {
      if (body.lane === undefined) {
        await clearOwnWatches(db, body.heatId, body.timerId);
      } else {
        await deleteWatch(db, body.heatId, Number(body.lane), body.timerId);
      }
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const lane = Number(body.lane);
    const timeMs = Number(body.timeMs);
    if (!Number.isFinite(lane) || lane < 1) throw new SyncError("Which lane?", 400);
    if (!Number.isFinite(timeMs) || timeMs <= 0) {
      throw new SyncError("That isn't a time.", 400);
    }

    await putWatch(db, params.meetId, {
      heatId: body.heatId,
      lane,
      timerId: body.timerId,
      timeMs: Math.round(timeMs),
      source: body.source === "typed" ? "typed" : "stopwatch",
      recordedAt: Number(body.recordedAt) || Date.now(),
      startedAt: Number(body.startedAt) || undefined,
      stoppedAt: Number(body.stoppedAt) || undefined,
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

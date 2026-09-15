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
import { mayDecide, mayRecordTime, meetAccess } from "~/lib/access.server";
import { clearOwnWatches, deleteWatch, putWatch } from "~/lib/meets.server";

/**
 * Times off a stopwatch.
 *
 *   POST   { heatId, lane, timerId, timeMs, ... } -> record
 *   DELETE { heatId, lane, timerId }              -> drop that one watch
 *   DELETE { heatId, timerId }                    -> drop that device's watches
 *
 * A watch is evidence, and there is one row per submitter per lane, so
 * recording one never overwrites anybody. That is also why this is open to
 * every coach of a racing team rather than to the administrator alone.
 *
 * **Who submitted is decided here, not by the caller.** Anyone reaching this
 * endpoint has a session, so the watch is filed under their user id and
 * carries it — a coach keeps one watch per lane whichever iPad they pick up,
 * and no client can file evidence under somebody else's name. The `timerId`
 * in the body is only a fallback for callers with no account, and the timing
 * phones don't come through here at all.
 *
 * The bulk delete is scoped to a single submitter on purpose: you may throw
 * away your own evidence — a false start, starting a heat again — and may not
 * throw away anyone else's, which is a decision and belongs at the desk.
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
      recordedAt?: number;
      startedAt?: number;
      stoppedAt?: number;
    }>(request);
    if (!body.heatId) throw new SyncError("Which watch?", 400);

    // Signed in, so the watch is theirs and says so. The body's `timerId` is
    // only reached by a caller with no account.
    const submitter = user?.id ?? body.timerId;
    if (!submitter) throw new SyncError("Which watch?", 400);

    if (request.method === "DELETE") {
      // Dropping a watch names one explicitly, because the desk drops other
      // people's — that is the whole point of the control. Clearing a whole
      // heat is only ever your own.
      if (body.lane === undefined) {
        await clearOwnWatches(db, body.heatId, submitter);
        return json({ ok: true });
      }

      // Throwing away somebody else's evidence is a decision, not a
      // correction, so it needs the desk. Your own you may always drop — a
      // false start, a fat-fingered tap, a heat started again.
      const whose = body.timerId ?? submitter;
      if (whose !== submitter && !mayDecide(access)) {
        throw new SyncError(
          "Only whoever is running this meet can drop another timer's watch.",
          403,
        );
      }
      await deleteWatch(db, body.heatId, Number(body.lane), whose);
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
      timerId: submitter,
      userId: user?.id,
      // What they are to this meet, right now, recorded so the reading can
      // never be re-weighed by a later change of role. Whoever runs the meet
      // rules on a time; a coach of a racing team is timing their own swimmer
      // from the side, which is a worse position and an interested one.
      role: access.admin ? "admin" : user ? "coach" : "timer",
      timeMs: Math.round(timeMs),
      recordedAt: Number(body.recordedAt) || Date.now(),
      startedAt: Number(body.startedAt) || undefined,
      stoppedAt: Number(body.stoppedAt) || undefined,
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

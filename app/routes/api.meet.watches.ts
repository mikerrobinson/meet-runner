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
import { deleteWatch, putWatch } from "~/lib/meets.server";

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
      seedId?: string;
      timerId?: string;
      timeMs?: number;
      recordedAt?: number;
      startedAt?: number;
      stoppedAt?: number;
    }>(request);
    if (!body.seedId) throw new SyncError("Which swim?", 400);

    // Signed in, so the watch is theirs and says so. The body's `timerId` is
    // only reached by a caller with no account.
    const submitter = user?.id ?? body.timerId;
    if (!submitter) throw new SyncError("Which watch?", 400);

    if (request.method === "DELETE") {
      // Throwing away somebody else's evidence is a decision, not a
      // correction, so it needs the desk. Your own you may always drop.
      const whose = body.timerId ?? submitter;
      if (whose !== submitter && !mayDecide(access)) {
        throw new SyncError(
          "Only whoever is running this meet can drop another timer's watch.",
          403,
        );
      }
      await deleteWatch(db, body.seedId, whose);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const timeMs = Number(body.timeMs);
    const hasTime = Number.isFinite(timeMs) && timeMs > 0;
    // A watch with neither a time nor a start is nothing at all. With a start
    // and no time it is a stopwatch that is running, which is a fact worth
    // keeping — it is how the desk sees a lane being covered.
    if (!hasTime && !body.startedAt) throw new SyncError("That isn't a time.", 400);

    await putWatch(db, params.meetId, {
      seedId: body.seedId,
      timerId: submitter,
      userId: user?.id,
      role: access.admin ? "admin" : user ? "coach" : "timer",
      timeMs: hasTime ? Math.round(timeMs) : undefined,
      recordedAt: Number(body.recordedAt) || Date.now(),
      startedAt: Number(body.startedAt) || undefined,
      stoppedAt: Number(body.stoppedAt) || undefined,
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

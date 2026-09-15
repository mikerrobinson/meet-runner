import type { Route } from "./+types/api.meet.results";
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
import { deleteResult, meetDetail, putResult } from "~/lib/meets.server";
import type { ResultStatus } from "~/types/meet";

/**
 * Signing a swim off, and taking it back.
 *
 *   POST   { seedId, status, timeMs } -> the official result
 *   DELETE { seedId }                 -> un-sign it
 *
 * Administrators only, which is the other half of the line watches sit on: an
 * extra watch never overwrites anybody, but with two schools in the water a DQ
 * isn't one school's call to make.
 *
 * The number is taken from the request rather than worked out here, because
 * what is being recorded is *what the administrator accepted* — the figure
 * that was on their screen when they pressed it. Re-deriving it on the server
 * would mean a watch landing in the same second could sign off a different
 * time from the one they were looking at.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    if (!mayDecide(access)) {
      throw new SyncError("Whoever is running this meet decides a lane.", 403);
    }

    const body = await readJson<{
      seedId?: string;
      status?: string;
      timeMs?: number;
    }>(request);
    if (!body.seedId) throw new SyncError("Which swim?", 400);

    if (request.method === "DELETE") {
      await deleteResult(db, body.seedId);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const detail = await meetDetail(db, params.meetId);
    const seed = detail?.seeds.find((s) => s.id === body.seedId);
    if (!seed) throw new SyncError("That swim is no longer in the meet", 404);

    const status: ResultStatus =
      body.status === "DQ" || body.status === "NS" ? body.status : "OK";
    const timeMs = Number(body.timeMs);

    await putResult(db, {
      seedId: seed.id,
      meetId: params.meetId,
      // Copied from the seed rather than the request: an administrator says
      // what the time was, not whose it was or which event it was in.
      eventId: seed.eventId,
      athleteId: seed.athleteId,
      status,
      // A no-show or a disqualification with nothing on the clock is zero,
      // which is how every screen already reads "no time".
      timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
      decidedBy: user?.id,
      decidedAt: Date.now(),
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

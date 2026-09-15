import type { Route } from "./+types/api.meet.seeds";
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
import { removeSeed, setSeed } from "~/lib/meets.server";

/**
 * Who is in a lane.
 *
 *   POST   { eventId, heat, lane, athleteId } -> the swim
 *   DELETE { seedId }                         -> take them out of it
 *
 * The single answer to "who is in lane 4". The coach seeding an event, an
 * administrator correcting the desk and a timer fixing a name behind the
 * blocks all write this same row, and the last one wins — because it is one
 * person deciding one thing, not a vote.
 *
 * Addressed by where the lane is rather than by a row id, because the seed may
 * not exist yet: a timer naming somebody behind the blocks is creating the
 * swim, not editing one.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    if (!mayRecordTime(access)) {
      throw new SyncError("Only the teams racing can seed a lane.", 403);
    }

    const body = await readJson<{
      seedId?: string;
      eventId?: string;
      heat?: number;
      lane?: number;
      athleteId?: string;
    }>(request);

    if (request.method === "DELETE") {
      if (!body.seedId) throw new SyncError("Which swim?", 400);
      await removeSeed(db, body.seedId);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const heat = Number(body.heat);
    const lane = Number(body.lane);
    if (!body.eventId || !body.athleteId) throw new SyncError("Which swim?", 400);
    if (!Number.isInteger(heat) || heat < 1) throw new SyncError("Which heat?", 400);
    if (!Number.isInteger(lane) || lane < 1) throw new SyncError("Which lane?", 400);

    const seed = await setSeed(db, params.meetId, {
      eventId: body.eventId,
      heat,
      lane,
      athleteId: body.athleteId,
    });
    return json({ seed });
  } catch (error) {
    return errorResponse(error);
  }
}

import type { Route } from "./+types/api.meet.entries";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { meetAccess, mayEnter } from "~/lib/access.server";
import { addEntry, meetDetail, removeEntry } from "~/lib/meets.server";
import { whyNotEnter } from "~/lib/events";

/**
 * Entering and scratching.
 *
 *   POST   { eventId, athleteId }  -> in
 *   DELETE { eventId, athleteId }  -> out
 *
 * One row per call, which is what lets two coaches fill in their own halves of
 * a dual meet at the same moment without either of them writing over the
 * other.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const access = await meetAccess(db, params.meetId, user);
    const body = await readJson<{ eventId?: string; athleteId?: string }>(request);
    if (!body.eventId || !body.athleteId) throw new SyncError("Which entry?", 400);

    const detail = await meetDetail(db, params.meetId);
    if (!detail) throw new SyncError("No such meet", 404);

    const teamsOf = (id: string) =>
      detail.enrollments.filter((e) => e.athleteId === id).map((e) => e.teamId);

    if (
      !mayEnter(access, body.athleteId, {
        athletesMayEnter: detail.meet.athletesMayEnter,
        teamsOf,
      })
    ) {
      throw new SyncError("That swimmer isn't yours to enter.", 403);
    }

    if (request.method === "DELETE") {
      await removeEntry(db, body.eventId, body.athleteId);
      return json({ ok: true });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    // The entry limits are the meet's rule, so they're enforced here rather
    // than only greyed out on the grid.
    const refusal = whyNotEnter(
      { events: detail.events, entries: detail.entries, limits: detail.meet.limits },
      body.athleteId,
      body.eventId,
    );
    if (refusal) throw new SyncError(refusal, 400);

    await addEntry(db, {
      meetId: params.meetId,
      eventId: body.eventId,
      athleteId: body.athleteId,
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

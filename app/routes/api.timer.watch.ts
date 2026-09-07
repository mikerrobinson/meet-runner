import type { Route } from "./+types/api.timer.watch";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { bearerToken } from "~/lib/auth.server";
import { grantFor, writeAsTimer } from "~/lib/grants.server";
import { watchId } from "~/types/meet";
import type { Athlete, WatchTime } from "~/types/meet";
import type { SyncObject } from "~/lib/objects";

/**
 * Times coming off a deck.
 *
 *   POST { watches[], athletes[] } -> { applied }
 *
 * Takes an array rather than one time because a phone on pool wifi queues what
 * it couldn't send and flushes the lot when the signal comes back. Each watch
 * carries the moment it was started and stopped, so arriving ten minutes late
 * makes it no less true.
 *
 * `athletes` rides along for the same reason. A timer adding a swimmer who
 * isn't on any list mints the id on their own device, so it works with no
 * signal at all, and the person and the time they were given reach the server
 * together or not at all.
 *
 * The client posts plain times and people; wrapping them as sync objects
 * happens here, so a timer's phone never has to know the object model exists.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const grant = await grantFor(db, bearerToken(request));
    if (!grant) {
      throw new SyncError("This timing link has expired. Scan the code again.", 403);
    }

    const body = await readJson<{
      watches?: Partial<WatchTime>[];
      athletes?: Partial<Athlete>[];
    }>(request);

    const now = Date.now();
    const objects: SyncObject[] = [];

    for (const raw of body.athletes ?? []) {
      const first = String(raw.firstName ?? "").trim().slice(0, 40);
      const last = String(raw.lastName ?? "").trim().slice(0, 40);
      if (!raw.id || (!first && !last)) continue;
      const athlete: Athlete = {
        id: raw.id,
        firstName: first,
        lastName: last,
        gender: raw.gender === "M" ? "M" : "F",
        // No birth date, ever, from this route. A timer is never asked for
        // one, and a blank field on a deck is a field somebody guesses at.
        team: String(raw.team ?? "").trim().slice(0, 24) || undefined,
      };
      objects.push({
        id: athlete.id,
        type: "athlete",
        teamId: grant.teamId,
        updatedAt: now,
        data: athlete,
      });
    }

    for (const raw of body.watches ?? []) {
      const lane = Number(raw.lane);
      const timeMs = Number(raw.timeMs);
      if (!raw.heatId || !raw.eventId || !raw.timerId) continue;
      if (!Number.isFinite(lane) || lane < 1) continue;
      if (!Number.isFinite(timeMs) || timeMs <= 0) continue;

      const watch: WatchTime = {
        // Built here rather than trusted: the id is what makes a re-sent watch
        // an update instead of a duplicate, so it has to be the one this
        // timer, lane and heat would always produce.
        id: watchId(raw.heatId, lane, raw.timerId),
        eventId: raw.eventId,
        heatId: raw.heatId,
        lane,
        timerId: raw.timerId,
        timeMs: Math.round(timeMs),
        recordedAt: Number(raw.recordedAt) || now,
        source: raw.source === "typed" ? "typed" : "stopwatch",
        athleteId: raw.athleteId || undefined,
        startedAt: Number(raw.startedAt) || undefined,
        stoppedAt: Number(raw.stoppedAt) || undefined,
      };
      objects.push({
        id: watch.id,
        type: "watch",
        teamId: grant.teamId,
        updatedAt: now,
        data: { meetId: grant.meetId, ...watch },
      });
    }

    if (objects.length === 0) return json({ applied: 0 });
    return json(await writeAsTimer(db, grant, objects));
  } catch (error) {
    return errorResponse(error);
  }
}

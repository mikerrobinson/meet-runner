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
import { seatFromWatch, visitorEnrollment } from "~/lib/timer.server";
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
      athletes?: Array<Partial<Athlete> & { teamId?: string }>;
      seats?: Array<{ heatId?: string; lane?: number; athleteId?: string }>;
    }>(request);

    const now = Date.now();
    const objects: SyncObject[] = [];
    const enrollable = new Set<string>();

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
      };
      objects.push({
        id: athlete.id,
        type: "athlete",
        scope: { kind: "global" },
        updatedAt: now,
        data: athlete,
      });

      // Which team the timer tapped becomes a roster entry, built from the
      // meet's own facts rather than taken on the phone's word.
      if (raw.teamId) {
        const enrollment = await visitorEnrollment(
          db,
          grant.meetId,
          raw.teamId,
          athlete.id,
          now,
        );
        if (enrollment) {
          objects.push(enrollment);
          enrollable.add(raw.teamId);
        }
      }
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
        scope: { kind: "meet", id: grant.meetId },
        updatedAt: now,
        data: watch,
      });
    }

    // A timer naming somebody other than whoever the lane holds moves them
    // into it. Worked out here from the meet's own heat rather than taken from
    // the phone, which may say who it saw and not what the running order is.
    //
    // Seats arrive on their own as well as on a watch: names are sorted out
    // behind the blocks, and waiting for the race to finish before telling
    // anyone is too late to be any use.
    const claims = [
      ...(body.seats ?? []),
      ...(body.watches ?? []).map((w) => ({
        heatId: w.heatId,
        lane: w.lane,
        athleteId: w.athleteId,
      })),
    ];

    const reseated: SyncObject[] = [];
    const seen = new Set<string>();
    for (const claim of claims) {
      if (!claim.athleteId || !claim.heatId) continue;
      const lane = Number(claim.lane);
      if (!Number.isFinite(lane) || lane < 1) continue;
      // A seat and the watch that follows it say the same thing; applying the
      // second over the first would be a second write for no change.
      const key = `${claim.heatId}:${lane}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reseated.push(
        ...(await seatFromWatch(
          db,
          grant.meetId,
          claim.heatId,
          lane,
          claim.athleteId,
          now,
        )),
      );
    }

    if (objects.length === 0 && reseated.length === 0) return json({ applied: 0 });
    return json(
      await writeAsTimer(db, grant, [...objects, ...reseated], [...enrollable]),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

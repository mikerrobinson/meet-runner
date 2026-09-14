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
import { grantFor } from "~/lib/grants.server";
import { putWatch, setSeat } from "~/lib/meets.server";
import { putAthlete } from "~/lib/athletes.server";
import { enrolVisitor } from "~/lib/teams.server";
import type { Athlete } from "~/types/meet";

/**
 * What a timing phone sends back.
 *
 *   POST { watches[], seats[], athletes[] } -> { applied }
 *
 * Arrays rather than one of each, because a phone on pool wifi queues what it
 * couldn't send and flushes the lot when the signal comes back. Every row is
 * keyed so that arriving twice is an update rather than a duplicate: a watch
 * by heat, lane and timer; a seat by heat and lane.
 *
 * `athletes` rides along for the same reason. A timer adding a swimmer who
 * isn't on any list mints the id on their own device, so it works with no
 * signal at all, and the person and the time they were given reach the server
 * together or not at all.
 *
 * What a grant may write is the whole of the security model here, so it's
 * listed rather than inferred: times, who is in a lane, and a new person plus
 * the roster row that follows from the team the timer tapped. Not the lineup,
 * not the heats, not a call. And the enrollment is minted from the meet's own
 * facts — a timer may say "this is a Horizon swimmer", not which team document
 * to write into.
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
      watches?: Array<Partial<{
        heatId: string;
        lane: number;
        timerId: string;
        timeMs: number;
        source: string;
        recordedAt: number;
        startedAt: number;
        stoppedAt: number;
      }>>;
      seats?: Array<{ heatId?: string; lane?: number; athleteId?: string }>;
      athletes?: Array<Partial<Athlete> & { teamId?: string }>;
    }>(request);

    let applied = 0;

    // People first: a seat or a watch may name somebody who only exists on the
    // phone so far, and a row pointing at nobody is worse than either.
    for (const raw of body.athletes ?? []) {
      const firstName = String(raw.firstName ?? "").trim().slice(0, 40);
      const lastName = String(raw.lastName ?? "").trim().slice(0, 40);
      if (!raw.id || (!firstName && !lastName)) continue;

      await putAthlete(db, {
        id: raw.id,
        firstName,
        lastName,
        gender: raw.gender === "M" ? "M" : "F",
        // No birth date, ever, from this route. A timer is never asked for
        // one, and a blank field on a deck is a field somebody guesses at.
      });
      applied += 1;

      if (raw.teamId) {
        await enrolVisitor(db, grant.meetId, raw.teamId, raw.id);
      }
    }

    // Who's in a lane. Sent on its own as well as before a time, because names
    // get sorted out behind the blocks and waiting for the race to finish
    // before telling anyone is too late to be useful.
    for (const seat of body.seats ?? []) {
      const lane = Number(seat.lane);
      if (!seat.heatId || !seat.athleteId) continue;
      if (!Number.isFinite(lane) || lane < 1) continue;
      // `setSeat` checks the heat belongs to a real event and the lane exists,
      // vacates whatever other lane they held, and enters them in the race.
      await setSeat(db, grant.meetId, {
        heatId: seat.heatId,
        lane,
        athleteId: seat.athleteId,
      });
      applied += 1;
    }

    for (const raw of body.watches ?? []) {
      const lane = Number(raw.lane);
      const timeMs = Number(raw.timeMs);
      if (!raw.heatId || !raw.timerId) continue;
      if (!Number.isFinite(lane) || lane < 1) continue;
      if (!Number.isFinite(timeMs) || timeMs <= 0) continue;

      await putWatch(db, grant.meetId, {
        heatId: raw.heatId,
        lane,
        timerId: raw.timerId,
        timeMs: Math.round(timeMs),
        source: raw.source === "typed" ? "typed" : "stopwatch",
        recordedAt: Number(raw.recordedAt) || Date.now(),
        startedAt: Number(raw.startedAt) || undefined,
        stoppedAt: Number(raw.stoppedAt) || undefined,
      });
      applied += 1;
    }

    return json({ applied });
  } catch (error) {
    return errorResponse(error);
  }
}

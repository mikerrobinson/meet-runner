import type { Route } from "./+types/api.athlete.link";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { isTeamCoach } from "~/lib/coaches.server";
import { getAthlete, linkAthleteToUser, athleteForUser } from "~/lib/athletes.server";
import type { Athlete } from "~/types/meet";

/**
 * Attach an account to a swimmer, or take it off again.
 *
 *   POST /api/athletes/:athleteId/link { teamId, userId }  -> link
 *   POST /api/athletes/:athleteId/link { teamId }          -> unlink
 *
 * A coach does this, never the person themselves. A roster record is an
 * assertion about who someone is, and letting anyone claim any swimmer would
 * make it worthless — the coach is the one who knows which address belongs to
 * which kid.
 *
 * The account is whichever one the coach names, searched across the whole
 * directory. It used to have to be on the team first — back when a swimmer
 * held a `memberships` row of their own — which put a join-and-approve dance
 * in front of the only thing that was ever being asserted here. What guards
 * this now is who's asking (a coach of this team) and the rule below (one
 * account, one swimmer); the contact proves itself when they sign in.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const actor = await requireUser(request, env);
    const body = await readJson<{ teamId?: string; userId?: string }>(request);
    if (!body.teamId) throw new SyncError("Which team?", 400);

    if (!(await isTeamCoach(db, actor.id, body.teamId))) {
      throw new SyncError("Only a coach can link an account to a swimmer", 403);
    }

    const athlete = await getAthlete(db, params.athleteId);
    if (!athlete) throw new SyncError("No such athlete", 404);

    // One account, one swimmer. Two roster rows claiming the same person is a
    // mistake worth refusing rather than quietly allowing.
    if (body.userId) {
      const held = await athleteForUser(db, body.userId);
      if (held && held.id !== athlete.id) {
        throw new SyncError(
          `That account is already ${held.firstName} ${held.lastName}.`.trim(),
          409,
        );
      }
    }

    await linkAthleteToUser(db, athlete.id, body.userId || null);
    const updated = { ...athlete, userId: body.userId || undefined };

    return json({ athlete: updated });
  } catch (error) {
    return errorResponse(error);
  }
}

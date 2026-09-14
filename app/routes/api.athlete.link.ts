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
import { canUseTeam, membershipIn, teamMembers } from "~/lib/auth.server";
import { isCoach } from "~/lib/identity";
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
 * The account has to already be on the team, so the existing join flow does
 * the work of proving the person can read that contact. This only says which
 * of the team's people a roster row is.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const actor = await requireUser(request, env);
    const body = await readJson<{ teamId?: string; userId?: string }>(request);
    if (!body.teamId) throw new SyncError("Which team?", 400);

    const allowed = await canUseTeam(db, actor.id, body.teamId);
    if (!allowed.ok) throw new SyncError(allowed.reason, 403);

    const mine = await membershipIn(db, actor.id, body.teamId);
    if (!mine || !isCoach(mine.role)) {
      throw new SyncError("Only a coach can link an account to a swimmer", 403);
    }

    // The target must be on this team. Without this, a coach could point one
    // of their roster rows at any account on the server.
    if (body.userId) {
      const members = await teamMembers(db, body.teamId);
      if (!members.some((m) => m.userId === body.userId)) {
        throw new SyncError(
          "That person isn't on this team yet. Admit them first.",
          400,
        );
      }
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

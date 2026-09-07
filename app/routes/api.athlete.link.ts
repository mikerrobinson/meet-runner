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
import { ensureObjectStore, pushObjects } from "~/lib/sync.server";
import type { Athlete } from "~/types/meet";
import type { SyncObject } from "~/lib/objects";

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

    await ensureObjectStore(db);
    const row = await db
      .prepare(
        "SELECT data FROM objects WHERE type = 'athlete' AND id = ? AND deleted_at IS NULL",
      )
      .bind(params.athleteId)
      .first<{ data: string }>();
    if (!row) throw new SyncError("No such athlete", 404);

    const athlete = JSON.parse(row.data) as Athlete;

    // One account, one swimmer. Two roster rows claiming the same person is a
    // mistake worth refusing rather than quietly allowing.
    if (body.userId) {
      const { results } = await db
        .prepare(
          "SELECT id, data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL",
        )
        .all<{ id: string; data: string }>();
      const clash = results.find(
        (other) =>
          other.id !== athlete.id &&
          (JSON.parse(other.data) as Athlete).userId === body.userId,
      );
      if (clash) {
        const held = JSON.parse(clash.data) as Athlete;
        throw new SyncError(
          `That account is already ${held.firstName} ${held.lastName}.`.trim(),
          409,
        );
      }
    }

    const updated: Athlete = { ...athlete, userId: body.userId || undefined };
    const object: SyncObject = {
      id: athlete.id,
      type: "athlete",
      scope: { kind: "global" },
      updatedAt: Date.now(),
      data: updated,
    };
    await pushObjects(db, [object]);

    return json({ athlete: updated });
  } catch (error) {
    return errorResponse(error);
  }
}

import type { Route } from "./+types/api.meet.me";
import {
  currentUser,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { membershipsFor } from "~/lib/auth.server";
import { isMeetAdmin } from "~/lib/admins.server";
import { ensureObjectStore } from "~/lib/sync.server";
import { isCoach, type Role } from "~/lib/identity";
import type { Athlete } from "~/types/meet";

/**
 * What am I, here?
 *
 *   GET /api/meets/:meetId/me
 *
 * Every screen under a meet asks this before it can decide what to show, and
 * none of them can work it out alone: whether you run the meet lives in one
 * table, whether you coach a team in it lives in another, and which swimmer
 * you are lives in the objects. One question, answered by the side that can
 * actually see all three.
 *
 * Answers for nobody too. An anonymous reader gets a shape saying they may
 * look and change nothing, which is what a results page wants.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);

    const none = {
      signedIn: false,
      admin: false,
      coachOf: [] as string[],
      athleteId: null as string | null,
    };
    if (!user) return json(none);

    await ensureObjectStore(db);
    const meetRow = await db
      .prepare(
        "SELECT data FROM objects WHERE type = 'meet' AND id = ? AND deleted_at IS NULL",
      )
      .bind(params.meetId)
      .first<{ data: string }>();
    const teamIds: string[] = meetRow
      ? ((JSON.parse(meetRow.data) as { teamIds?: string[] }).teamIds ?? [])
      : [];

    const memberships = await membershipsFor(db, user.id);
    const coachOf = memberships
      .filter(
        (m) =>
          m.status === "active" &&
          isCoach(m.role as Role) &&
          teamIds.includes(m.teamId),
      )
      .map((m) => m.teamId);

    // Which swimmer this account is, if a coach has linked one.
    const { results } = await db
      .prepare(
        "SELECT data FROM objects WHERE type = 'athlete' AND deleted_at IS NULL",
      )
      .all<{ data: string }>();
    const mine = results
      .map((row) => JSON.parse(row.data) as Athlete)
      .find((a) => a.userId === user.id);

    return json({
      signedIn: true,
      admin: await isMeetAdmin(db, user.id, params.meetId),
      coachOf,
      athleteId: mine?.id ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

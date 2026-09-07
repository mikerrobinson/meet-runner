import type { Route } from "./+types/api.members";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { canUseTeam, membershipIn, teamMembers } from "~/lib/auth.server";
import { isCoach } from "~/lib/identity";

/**
 *   GET /api/members?teamId=… -> everyone active on the team
 *
 * Coaches only, not members generally. A roster is public, but the accounts
 * behind it are a list of email addresses and phone numbers — including other
 * families' — and being on the team is not a reason to be handed them. The
 * only thing that needs this is the coach's own "which account is this
 * swimmer" picker.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const teamId = new URL(request.url).searchParams.get("teamId");
    if (!teamId) throw new SyncError("Which team?", 400);

    const user = await requireUser(request, env);
    const allowed = await canUseTeam(db, user.id, teamId);
    if (!allowed.ok) throw new SyncError(allowed.reason, 403);

    const mine = await membershipIn(db, user.id, teamId);
    if (!mine || !isCoach(mine.role)) {
      throw new SyncError("Coaches only", 403);
    }

    return json({ members: await teamMembers(db, teamId) });
  } catch (error) {
    return errorResponse(error);
  }
}

import type { Route } from "./+types/api.public.user";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { userDashboard } from "~/lib/public.server";

/**
 *   GET /api/users/:userId -> the teams they're on, their meets, and the
 *   athlete record they are, if a coach has linked one
 *
 * The one endpoint here that isn't public. A team's results are everybody's;
 * which teams a particular person belongs to is theirs, so this answers only
 * for the caller themselves.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    if (user.id !== params.userId) {
      throw new SyncError("That's someone else's dashboard", 403);
    }
    const dashboard = await userDashboard(db, params.userId!);
    if (!dashboard) throw new SyncError("No such user", 404);
    return json(dashboard);
  } catch (error) {
    return errorResponse(error);
  }
}

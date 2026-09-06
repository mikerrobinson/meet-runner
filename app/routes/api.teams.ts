import type { Route } from "./+types/api.teams";
import {
  currentUser,
  errorResponse,
  json,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { membershipsFor } from "~/lib/auth.server";
import { listTeamChoices } from "~/lib/sync.server";

/**
 * The seasons this device may switch between.
 *
 * Which is to say: the ones the signed-in person is actually on. Answering
 * with every team the server holds was how a device with nothing on it used to
 * find its way home, and that job now belongs to signing in — so a caller with
 * no session gets nothing rather than a directory of other people's rosters.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    const db = requireDb(env);

    const user = await currentUser(request, env);
    if (!user) return json({ teams: [] });

    const mine = new Set(
      (await membershipsFor(db, user.id))
        .filter((m) => m.status === "active")
        .map((m) => m.teamId),
    );
    const teams = (await listTeamChoices(db)).filter((team) => mine.has(team.id));
    return json({ teams });
  } catch (error) {
    return errorResponse(error);
  }
}

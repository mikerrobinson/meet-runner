import type { Route } from "./+types/api.public.team";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { publicTeamDetail } from "~/lib/public.server";

/**
 *   GET /api/teams/:teamId -> the team, its seasons with rosters, and its meets
 *
 * Rosters carry no birth dates. `public.ts` builds an athlete by naming the
 * fields that may travel, so that stays true without this route checking.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const team = await publicTeamDetail(db, params.teamId!);
    if (!team) throw new SyncError("No such team", 404);
    return json(team);
  } catch (error) {
    return errorResponse(error);
  }
}

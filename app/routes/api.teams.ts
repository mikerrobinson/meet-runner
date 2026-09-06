import type { Route } from "./+types/api.teams";
import {
  errorResponse,
  json,
  listTeams,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/meets.server";

/**
 * Every team the server holds.
 *
 * A device with nothing on it asks here rather than having the server guess
 * which team it meant — the guess is what once let an empty team shadow a
 * real roster.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    return json({ teams: await listTeams(requireDb(env)) });
  } catch (error) {
    return errorResponse(error);
  }
}

import type { Route } from "./+types/api.public.meets";
import { errorResponse, json, requireDb, type SyncEnv } from "~/lib/api.server";
import { listPublicMeets } from "~/lib/public.server";

/**
 * Every meet, or one team's.
 *
 *   GET /api/meets            -> all of them, newest first
 *   GET /api/meets?teamId=…   -> just the ones that team is racing
 *
 * No authentication. A meet is a public event: the heat sheet is handed out at
 * the door and the results are read over a PA. What this returns is the same
 * information, and nothing that isn't on the sheet.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const teamId = new URL(request.url).searchParams.get("teamId") ?? undefined;
    return json({ meets: await listPublicMeets(db, { teamId }) });
  } catch (error) {
    return errorResponse(error);
  }
}

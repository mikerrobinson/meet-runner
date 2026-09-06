import type { Route } from "./+types/api.meets";
import {
  errorResponse,
  json,
  listMeetSummaries,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/meets.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    // `?teamId=` scopes the list to one team's season; without it you get
    // everything, which is what the sync panel's browse view wants.
    const teamId = new URL(request.url).searchParams.get("teamId") ?? undefined;
    return json({ meets: await listMeetSummaries(requireDb(env), teamId) });
  } catch (error) {
    return errorResponse(error);
  }
}

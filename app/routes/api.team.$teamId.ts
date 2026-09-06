import type { Route } from "./+types/api.team.$teamId";
import {
  SyncError,
  errorResponse,
  getTeam,
  json,
  parseTeamBody,
  putTeam,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/meets.server";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    return json({ team: await getTeam(requireDb(env), params.teamId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    if (request.method !== "PUT" && request.method !== "POST") {
      throw new SyncError("Use PUT to save the team", 405);
    }
    const team = await parseTeamBody(request);
    // The id in the path is the one that counts; a body claiming to be a
    // different team is a bug on the client, not a rename.
    if (team.id !== params.teamId) {
      throw new SyncError("That body is a different team", 400);
    }
    return json(await putTeam(requireDb(env), team));
  } catch (error) {
    return errorResponse(error);
  }
}

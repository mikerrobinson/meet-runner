import type { Route } from "./+types/api.team";
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

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    return json({ team: await getTeam(requireDb(env)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    if (request.method !== "PUT" && request.method !== "POST") {
      throw new SyncError("Use PUT to save the team", 405);
    }
    return json(await putTeam(requireDb(env), await parseTeamBody(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

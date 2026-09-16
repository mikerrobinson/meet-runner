import type { Route } from "./+types/api.invites";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { inspectInvite } from "~/lib/auth.server";

/**
 * What an invitation is for.
 *
 *   GET ?token= -> { teamId, name, code }
 *
 * Deliberately open, because it's read by someone who isn't signed in yet:
 * the sign-in screen uses it to say which team the link joins, so nobody has
 * to type a contact into a page that won't say what it's for. Holding the
 * token is the whole credential, and it says nothing beyond the team's name.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const token = new URL(request.url).searchParams.get("token");
    if (!token) throw new SyncError("No invitation given", 400);

    // Tagged, so the sign-in screen can say "coach Horizon" or "help run
    // Tuesday's meet" rather than guessing from which fields are present.
    const invite = await inspectInvite(requireDb(env), token);
    if (!invite) throw new SyncError("That invitation has expired or been used.", 404);
    return json(invite);
  } catch (error) {
    return errorResponse(error);
  }
}

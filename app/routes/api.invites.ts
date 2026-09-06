import type { Route } from "./+types/api.invites";
import {
  SyncError,
  appBaseUrl,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { createInvite, inspectInvite, membershipIn } from "~/lib/auth.server";
import { INVITABLE_ROLES, canAdmit, type Role } from "~/lib/identity";

/**
 * What an invitation is for.
 *
 *   GET ?token= -> { teamId, name, code, role }
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

    const invite = await inspectInvite(requireDb(env), token);
    if (!invite) throw new SyncError("That invitation has expired or been used.", 404);
    return json(invite);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Mint one.
 *
 *   POST { teamId, role } -> { token, url }
 *
 * The link is the credential, so it comes back once and is never retrievable
 * again — a coach who loses it makes another rather than looking the old one
 * up.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson<{ teamId?: string; role?: string }>(request);
    if (!body.teamId) throw new SyncError("Which team?", 400);

    if (!canAdmit(await membershipIn(db, user.id, body.teamId))) {
      throw new SyncError("Only a coach can invite people", 403);
    }

    const role = (body.role ?? "coach") as Role;
    if (!INVITABLE_ROLES.includes(role)) {
      throw new SyncError("That role can't be handed out by invitation", 400);
    }

    const token = await createInvite(db, body.teamId, role, user.id);
    return json({
      token,
      role,
      url: `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

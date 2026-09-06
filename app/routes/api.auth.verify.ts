import type { Route } from "./+types/api.auth.verify";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import {
  createSession,
  redeemInvite,
  sessionPayload,
  verifyChallenge,
} from "~/lib/auth.server";
import { messageFor, parseContact } from "~/lib/identity";

/**
 * Hand back the code and get a session.
 *
 *   POST { contact, code, invite? } -> { token, ...session }
 *
 * The token is returned once and never again — the server keeps only a hash —
 * so the client has to store it here or ask for a new code.
 *
 * An invite is redeemed in the same request rather than after it. Following a
 * link, signing in, and finding you still aren't on the team is the failure
 * this avoids, and doing both together means there's no window where the
 * account exists but the membership doesn't.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const body = await readJson<{ contact?: string; code?: string; invite?: string }>(
      request,
    );
    const parsed = parseContact(body.contact ?? "");
    if (!parsed.ok) throw new SyncError(parsed.error, 400);

    const db = requireDb(env);
    const result = await verifyChallenge(db, parsed.contact, body.code ?? "");
    if (!result.ok) throw new SyncError(messageFor(result.check), 401);

    let invitedTeamId: string | null = null;
    let inviteError: string | undefined;
    if (body.invite) {
      const redeemed = await redeemInvite(db, body.invite, result.user.id);
      // A spent invite doesn't fail the sign-in: they're signed in either way,
      // and being told so while also being told the link is stale beats being
      // bounced back to a screen that says nothing.
      if (redeemed.ok) invitedTeamId = redeemed.membership.teamId;
      else inviteError = redeemed.error;
    }

    const token = await createSession(db, result.user.id);
    const payload = await sessionPayload(db, result.user, invitedTeamId);

    return json({ token, isNew: result.isNew, ...payload, ...(inviteError ? { inviteError } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}

import type { Route } from "./+types/api.timer.grant";
import {
  SyncError,
  appBaseUrl,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { canUseTeam } from "~/lib/auth.server";
import { activeGrant, issueGrant, revokeGrants } from "~/lib/grants.server";

/**
 * The coach's end of the QR code.
 *
 *   GET    ?meetId=      -> whether a link is live, and when it dies
 *   POST   { meetId, teamId, date } -> a fresh link, retiring the old one
 *   DELETE { meetId }    -> kill it now
 *
 * Issuing is also how you revoke, which is why there's no separate rotate:
 * a coach who thinks the code has got out taps the same button and prints a
 * new sheet. The link itself comes back exactly once.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const meetId = new URL(request.url).searchParams.get("meetId");
    if (!meetId) throw new SyncError("Which meet?", 400);

    // Only says whether a link exists and when it expires — never the token.
    const user = await currentUser(request, env);
    if (!user) throw new SyncError("Sign in first", 401);

    return json({ grant: await activeGrant(db, meetId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson<{ meetId?: string; teamId?: string; date?: string }>(
      request,
    );
    if (!body.meetId || !body.teamId) throw new SyncError("Which meet?", 400);

    const allowed = await canUseTeam(db, user.id, body.teamId);
    if (!allowed.ok) throw new SyncError(allowed.reason, 403);

    if (request.method === "DELETE") {
      await revokeGrants(db, body.meetId);
      return json({ grant: null });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const { token, expiresAt } = await issueGrant(db, {
      id: body.meetId,
      teamId: body.teamId,
      date: body.date ?? new Date().toISOString().slice(0, 10),
    });

    return json({
      url: `${appBaseUrl(request)}t/${token}`,
      expiresAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

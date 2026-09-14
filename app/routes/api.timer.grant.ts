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
import { activeGrant, issueGrant, revokeGrants } from "~/lib/grants.server";
import { meetAccess, mayEditMeet } from "~/lib/access.server";
import { getMeet } from "~/lib/meets.server";

/**
 * The coach's end of the QR code.
 *
 *   GET    ?meetId=   -> whether a link is live, and when it dies
 *   POST   { meetId }  -> a fresh link, retiring the old one
 *   DELETE { meetId }  -> kill it now
 *
 * The meet's own date and host team are read here rather than accepted from
 * the caller. A client may ask for a code; it doesn't get to say which team's
 * authority it is issued under, or when it should expire.
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
    const body = await readJson<{ meetId?: string }>(request);
    if (!body.meetId) throw new SyncError("Which meet?", 400);

    // Whoever runs the meet may hand out timing codes for it. Asked of the
    // meet rather than of a team, because a meet belongs to no team.
    const access = await meetAccess(db, body.meetId, user);
    if (!mayEditMeet(access)) {
      throw new SyncError("Whoever is running this meet issues its codes.", 403);
    }

    const meet = await getMeet(db, body.meetId);
    if (!meet) throw new SyncError("No such meet", 404);

    if (request.method === "DELETE") {
      await revokeGrants(db, body.meetId);
      return json({ grant: null });
    }
    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    const { token, expiresAt } = await issueGrant(db, {
      id: meet.id,
      teamId: meet.hostTeamId ?? meet.teamIds[0] ?? "",
      date: meet.date,
    });

    return json({
      url: `${appBaseUrl(request)}t/${token}`,
      expiresAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

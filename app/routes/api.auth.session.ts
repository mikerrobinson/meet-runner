import type { Route } from "./+types/api.auth.session";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import {
  bearerToken,
  endAllSessions,
  endSession,
  membershipIn,
  sessionPayload,
  setLastPlace,
  setName,
} from "~/lib/auth.server";

/**
 * The session this device holds.
 *
 *   GET    -> { user, memberships, openTeamId, joinable } or { user: null }
 *   PATCH  -> same, after recording a name or where they are
 *   DELETE -> sign out (`?everywhere` for every device)
 *
 * A missing or dead token is answered with `user: null` and a 200 rather than
 * a 401: "nobody is signed in" is the ordinary state of a fresh device, not an
 * error, and treating it as one makes every console on the deck red.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const user = await currentUser(request, env);
    if (!user) return json({ user: null });
    return json(await sessionPayload(requireDb(env), user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);

    if (request.method === "DELETE") {
      const user = await requireUser(request, env);
      if (new URL(request.url).searchParams.has("everywhere")) {
        await endAllSessions(db, user.id);
      } else {
        const token = bearerToken(request);
        if (token) await endSession(db, token);
      }
      return json({ user: null });
    }

    if (request.method !== "PATCH") throw new SyncError("Use PATCH or DELETE", 405);

    const user = await requireUser(request, env);
    const body = await readJson<{
      name?: string;
      lastTeamId?: string;
      lastSeasonId?: string | null;
    }>(request);

    if (body.name !== undefined) await setName(db, user.id, body.name);
    // Where someone is only counts once they're actually on the team, so a
    // stale or hopeful team id can't be parked on the account.
    if (body.lastTeamId) {
      const membership = await membershipIn(db, user.id, body.lastTeamId);
      if (membership?.status === "active") {
        await setLastPlace(db, user.id, body.lastTeamId, body.lastSeasonId ?? null);
      }
    }

    const fresh = await requireUser(request, env);
    return json(await sessionPayload(db, fresh));
  } catch (error) {
    return errorResponse(error);
  }
}

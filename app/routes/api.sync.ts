import type { Route } from "./+types/api.sync";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  requireAuth,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { canUseTeam } from "~/lib/auth.server";
import { pullObjects, pushObjects } from "~/lib/sync.server";
import type { SyncObject } from "~/lib/objects";

/**
 * One endpoint for the whole exchange: send what changed, get back what
 * changed elsewhere.
 *
 *   POST { teamId, cursor, changes[] } -> { cursor, changes[], more, refused[] }
 *
 * Pushing and pulling in one round trip is what makes this usable on pool
 * wifi, where the cost is the round trip rather than the bytes.
 *
 * One access check, for the whole exchange: this endpoint hands over an entire
 * roster, so the question worth asking is whether the caller belongs to the
 * team. Which *parts* a member may change is the app's business, not this
 * endpoint's.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
    if (request.method !== "POST") {
      throw new SyncError("Use POST to sync", 405);
    }

    const body = (await request.json().catch(() => null)) as {
      teamId?: string;
      cursor?: string;
      changes?: SyncObject[];
    } | null;

    if (!body?.teamId) throw new SyncError("Which team?", 400);

    const db = requireDb(env);
    const changes = body.changes ?? [];

    // Objects can only ever be written into their own team's season.
    const foreign = changes.find((o) => o.teamId !== body.teamId);
    if (foreign) {
      throw new SyncError("That batch mixes teams", 400);
    }

    const user = await currentUser(request, env);
    const allowed = await canUseTeam(db, user?.id ?? null, body.teamId);
    if (!allowed.ok) throw new SyncError(allowed.reason, 403);

    const pushed = await pushObjects(db, changes);
    const pulled = await pullObjects(db, body.teamId, body.cursor);

    return json({
      cursor: pulled.cursor,
      changes: pulled.changes,
      more: pulled.more,
      applied: pushed.applied,
      refused: pushed.refused,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

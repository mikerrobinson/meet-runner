import type { Route } from "./+types/api.timer.meet";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { deviceId, grantFor, grantToken } from "~/lib/grants.server";
import { timerSnapshot } from "~/lib/timer.server";

/**
 * Everything a timer's phone needs, and nothing more.
 *
 *   GET /api/timer/meet -> one meet's running order, lanes, names
 *
 * Nothing is asked for. The grant cookie says which meet, and the device
 * cookie says which phone — so `mine` comes back as this phone's own watches
 * without the page having to know its own name.
 *
 * The grant token is the whole credential; there is no account behind it. A
 * dead or rotated token is a 403 rather than a redirect to sign in, because a
 * timer has nothing to sign in *with* — the answer is to scan the code again.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    // Two different answers, because they need two different things done
    // about them: somebody who opened `/timer` directly has never scanned
    // anything, and telling them their link expired sends them looking for a
    // link they never had.
    const token = grantToken(request);
    if (!token) {
      throw new SyncError(
        "Scan the code your coach gave you to start timing.",
        401,
      );
    }
    const grant = await grantFor(db, token);
    if (!grant) {
      throw new SyncError("This timing link has expired. Scan the code again.", 403);
    }

    // A browser with no device cookie gets a throwaway id, and so an empty
    // `mine`. That is the honest answer — a phone the server has never seen
    // has taken no times — and this is a read, so nothing is filed under it.
    const snapshot = await timerSnapshot(db, grant, deviceId(request));
    if (!snapshot) throw new SyncError("That meet is no longer on the server", 404);

    return json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

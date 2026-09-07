import type { Route } from "./+types/api.timer.meet";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { bearerToken } from "~/lib/auth.server";
import { grantFor } from "~/lib/grants.server";
import { timerSnapshot } from "~/lib/timer.server";

/**
 * Everything a timer's phone needs, and nothing more.
 *
 *   GET /api/timer/meet?timerId=… -> one meet's running order, lanes, names
 *
 * The grant token is the whole credential; there is no account behind it. A
 * dead or rotated token is a 403 rather than a redirect to sign in, because a
 * timer has nothing to sign in *with* — the answer is to scan the code again.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const grant = await grantFor(db, bearerToken(request));
    if (!grant) {
      throw new SyncError("This timing link has expired. Scan the code again.", 403);
    }

    const timerId = new URL(request.url).searchParams.get("timerId") ?? "";
    if (!timerId) throw new SyncError("Which device?", 400);

    const snapshot = await timerSnapshot(db, grant, timerId);
    if (!snapshot) throw new SyncError("That meet is no longer on the server", 404);

    return json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

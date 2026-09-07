import type { Route } from "./+types/api.public.meet";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { publicMeetDetail } from "~/lib/public.server";

/**
 *   GET /api/meets/:meetId -> the meet, its teams, and every event's results
 *
 * Results are derived from the watches on each lane rather than stored, so
 * this is always the same answer every device would compute for itself.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const meet = await publicMeetDetail(db, params.meetId!);
    if (!meet) throw new SyncError("No such meet", 404);
    return json(meet);
  } catch (error) {
    return errorResponse(error);
  }
}

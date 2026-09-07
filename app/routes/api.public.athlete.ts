import type { Route } from "./+types/api.public.athlete";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { publicAthleteDetail } from "~/lib/public.server";

/**
 *   GET /api/athletes/:athleteId -> who they are, who they've swum for, and
 *   every time they've recorded, with their best in each race marked
 *
 * Bests are per race *and* course: a 100 Free in yards and one in metres are
 * different records, and treating either as the other's personal best is the
 * kind of mistake a swimmer notices immediately.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const athlete = await publicAthleteDetail(db, params.athleteId!);
    if (!athlete) throw new SyncError("No such athlete", 404);
    return json(athlete);
  } catch (error) {
    return errorResponse(error);
  }
}

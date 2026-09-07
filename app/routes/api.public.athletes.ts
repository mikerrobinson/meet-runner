import type { Route } from "./+types/api.public.athletes";
import { errorResponse, json, requireDb, type SyncEnv } from "~/lib/api.server";
import { listPublicAthletes } from "~/lib/public.server";

/**
 *   GET /api/athletes?q=…&limit=… -> people, filtered by name
 *
 * Everyone, not one team's roster: an athlete belongs to no team, and this is
 * the list a coach searches when they need to know whether the swimmer in front
 * of them already exists rather than typing a second copy.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit"));
    return json({
      athletes: await listPublicAthletes(db, {
        q: params.get("q") ?? undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

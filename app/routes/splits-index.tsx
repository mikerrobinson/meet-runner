import { redirect } from "react-router";
import type { Route } from "./+types/splits-index";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { meetDetail } from "~/lib/meets.server";
import { heatsOf } from "~/lib/timing";

/**
 * `/meets/:meetId/splits` on its own — send whoever's here to the first
 * event's heat. The leaf (`splits-heat.tsx`) renders the "no events yet"
 * state itself when there's nowhere to send them.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const detail = await meetDetail(db, params.meetId);
  const first = detail?.events[0];
  if (!first) throw redirect(`/meets/${params.meetId}/splits/1/1`);
  const heat = heatsOf(detail, first.id)[0] ?? 1;
  throw redirect(`/meets/${params.meetId}/splits/${first.position + 1}/${heat}`);
}

export default function SplitsIndex() {
  return null;
}

import { redirect } from "react-router";
import type { Route } from "./+types/admin-index";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { meetDetail } from "~/lib/meets.server";
import { heatsOf } from "~/lib/timing";

/**
 * `/meets/:meetId/admin` on its own — send whoever's here to the first
 * event's heat desk. The shell (`admin.tsx`) renders the "no events yet"
 * state itself when there's nowhere to send them.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const detail = await meetDetail(db, params.meetId);
  const first = detail?.events[0];
  if (!first) return null;
  const heat = heatsOf(detail, first.id)[0] ?? 1;
  throw redirect(`/meets/${params.meetId}/admin/${first.position + 1}/${heat}`);
}

export default function AdminIndex() {
  return null;
}

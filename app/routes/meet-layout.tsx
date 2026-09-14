import { Link, Outlet, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/meet-layout";
import { EmptyState } from "~/components/ui";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { meetAccess, type MeetAccess } from "~/lib/access.server";
import { meetDetail } from "~/lib/meets.server";
import type { MeetDetail } from "~/types/meet";

/**
 * Everything under `/meets/:meetId`, loaded once.
 *
 * The meet and what you may do to it come back together, from the same
 * request. Children read them with `useMeet()` rather than fetching again —
 * nested loaders run in parallel, so one read here beats five below, and more
 * importantly there is only one answer in play. The screens used to render
 * from a copy on the device while a separate request decided permissions from
 * the copy on the server; when those disagreed you lost the editing controls
 * on your own meet.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);

  const [detail, access] = await Promise.all([
    meetDetail(db, params.meetId),
    meetAccess(db, params.meetId, user),
  ]);

  return { detail, access };
}

export interface MeetContext {
  detail: MeetDetail;
  access: MeetAccess;
}

/**
 * The meet this screen is under, and what you may do to it.
 *
 * Children call this instead of taking a `meet` prop or reaching for a store.
 * It throws rather than returning null: the layout has already established the
 * meet exists, so a child reaching here without one is a routing bug, not a
 * state to render around.
 */
export function useMeet(): MeetContext {
  const data = useRouteLoaderData<typeof loader>("routes/meet-layout");
  if (!data?.detail) throw new Error("useMeet used outside a meet route");
  return { detail: data.detail, access: data.access };
}

export default function MeetLayout({ loaderData }: Route.ComponentProps) {
  if (!loaderData.detail) {
    return (
      <EmptyState title="No such meet">
        It may have been deleted.{" "}
        <Link to="/meets" className="font-semibold text-blue-600 underline">
          Back to meets
        </Link>
        .
      </EmptyState>
    );
  }
  return <Outlet />;
}

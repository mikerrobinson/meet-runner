import { Link, Outlet, useParams } from "react-router";
import type { Route } from "./+types/meet-layout";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { publicMeetDetail } from "~/lib/public.server";
import { formatTime } from "~/lib/time";
import { meetTypeLabel } from "~/types/meet";
import { useAppStore } from "~/state/app-store";
import type { SyncEnv } from "~/lib/api.server";

/**
 * Guards every screen under /meets/:meetId. Children can rely on the meet
 * existing rather than each null-checking it.
 *
 * A meet this device doesn't hold isn't an error any more — it's somebody
 * else's meet, and those are public. So the fallback is the read-only view
 * rather than a dead end: results a parent can open from a link, without the
 * setup and stopwatch screens that would mean nothing to them.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { published: null };
  try {
    return { published: await publicMeetDetail(env.DB, params.meetId) };
  } catch {
    return { published: null };
  }
}

export default function MeetLayout({ loaderData }: Route.ComponentProps) {
  const { meets } = useAppStore();
  const { meetId } = useParams();
  const meet = meets.find((m) => m.id === meetId);

  // Local first, always: on a deck the store is the truth and the server may
  // be unreachable.
  if (meet) return <Outlet />;

  const published = loaderData.published;
  if (!published) {
    return (
      <EmptyState title="That meet isn't on this device">
        It may have been deleted, or belong to another device.{" "}
        <Link to="/meets" className="font-semibold text-blue-600 underline">
          Back to meets
        </Link>
        .
      </EmptyState>
    );
  }

  const swum = published.results.filter((event) => event.placings.length > 0);

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-xl font-bold">{published.name}</h2>
        <p className="text-sm text-slate-500">
          {[
            published.date,
            meetTypeLabel(published.type),
            published.course,
            published.location,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="mt-1 flex flex-wrap gap-1.5">
          {published.teams.map((team) => (
            <Link
              key={team.id}
              to={`/teams/${team.id}`}
              className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {team.name}
            </Link>
          ))}
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Read-only — this meet is on the server, not on this device.
        </p>
      </Card>

      <Card>
        <SectionTitle>Results</SectionTitle>
        {swum.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            Times appear here as they&rsquo;re taken.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {swum.map((event) => (
              <div key={event.id}>
                <h3 className="mb-1 text-sm font-bold">{event.name}</h3>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {event.placings.map((placing, index) => (
                    <li
                      key={`${placing.lane}:${index}`}
                      className="flex items-center gap-3 py-1.5 text-sm"
                    >
                      <span className="w-5 text-center font-bold text-slate-400">
                        {placing.place ?? "—"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {placing.athlete
                            ? `${placing.athlete.firstName} ${placing.athlete.lastName}`
                            : "(unknown)"}
                          {placing.attributed && (
                            <span
                              className="ml-1.5 text-xs font-normal text-amber-700 dark:text-amber-400"
                              title="Nobody was seeded in this lane; a timer said who it was."
                            >
                              per timer
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {placing.team?.code ?? placing.team?.name ?? "—"} · lane{" "}
                          {placing.lane}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums">
                        {placing.status === "OK"
                          ? formatTime(placing.timeMs)
                          : placing.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

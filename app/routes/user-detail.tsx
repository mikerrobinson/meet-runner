import { Link } from "react-router";
import type { Route } from "./+types/user-detail";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { formatTime } from "~/lib/time";
import { publicAthleteDetail, userDashboard } from "~/lib/public.server";
import { currentUser } from "~/lib/api.server";
import { meetTypeLabel } from "~/types/meet";
import type { SyncEnv } from "~/lib/api.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "You · Meet Runner" }];
}

/**
 * Somebody's own page.
 *
 * The one screen here that isn't public: a team's results are everyone's, but
 * which teams a particular person belongs to is theirs. So this answers only
 * for the person asking, and anyone else gets nothing rather than a redacted
 * version of somebody's business.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { dashboard: null, swims: null, mine: false };

  try {
    const me = await currentUser(request, env);
    console.log(
      "me",
      JSON.stringify(me, null, 2),
      "params.userId",
      params.userId,
    );
    if (!me || me.id !== params.userId) {
      return { dashboard: null, swims: null, mine: false };
    }

    const dashboard = await userDashboard(env.DB, params.userId);
    // Their own times, when a coach has said which swimmer they are.
    const swims = dashboard?.athlete
      ? ((await publicAthleteDetail(env.DB, dashboard.athlete.id))?.swims ??
        null)
      : null;

    return { dashboard, swims, mine: true };
  } catch {
    return { dashboard: null, swims: null, mine: false };
  }
}

export default function UserDetail({ loaderData }: Route.ComponentProps) {
  const { dashboard, swims, mine } = loaderData;

  if (!mine || !dashboard) {
    return (
      <Card>
        <EmptyState title="Not your page">
          Sign in to see your own teams and times.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-xl font-bold">{dashboard.name ?? "You"}</h2>
        {dashboard.athlete ? (
          <p className="text-sm text-slate-500">
            Swimming as{" "}
            <Link
              to={`/athletes/${dashboard.athlete.id}`}
              className="font-semibold text-blue-600"
            >
              {dashboard.athlete.firstName} {dashboard.athlete.lastName}
            </Link>
          </p>
        ) : (
          <p className="text-sm text-slate-500">
            Not linked to a swimmer. A coach can connect your account to your
            roster entry, and your times will show up here.
          </p>
        )}
      </Card>

      <Card>
        <SectionTitle>Your teams</SectionTitle>
        {dashboard.teams.length === 0 ? (
          <EmptyState title="No teams yet">
            Ask to join one and a coach will let you in.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {dashboard.teams.map((team) => (
              <li key={team.id}>
                <Link
                  to={`/teams/${team.id}`}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {team.name}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {team.role.replace("_", " ")}
                      {team.status !== "active" && ` · ${team.status}`}
                    </span>
                  </span>
                  <span aria-hidden className="shrink-0 text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {swims && swims.length > 0 && (
        <Card>
          <SectionTitle>Your times</SectionTitle>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {swims.map((swim, index) => (
              <li
                key={`${swim.meetId}:${swim.eventName}:${index}`}
                className="flex items-center gap-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {swim.eventName}
                    {swim.best && (
                      <span className="ml-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                        best
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {swim.date} · {swim.meetName} · {swim.course}
                  </span>
                </span>
                <span className="font-mono tabular-nums">
                  {swim.status === "OK" ? formatTime(swim.timeMs) : swim.status}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionTitle>Your meets</SectionTitle>
        {dashboard.meets.length === 0 ? (
          <EmptyState title="No meets yet">
            Meets your teams are racing show up here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {dashboard.meets.map((meet) => (
              <li key={meet.id}>
                <Link
                  to={`/meets/${meet.id}`}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {meet.name}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {meet.date} · {meetTypeLabel(meet.type)} · {meet.times}{" "}
                      time{meet.times === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span aria-hidden className="shrink-0 text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

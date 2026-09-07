import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/team-detail";
import { Banner, Card, EmptyState, SectionTitle, Segmented } from "~/components/ui";
import { publicTeamDetail } from "~/lib/public.server";
import { meetTypeLabel } from "~/types/meet";
import type { SyncEnv } from "~/lib/api.server";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.team?.name ?? "Team"} · Meet Runner` }];
}

/**
 * A team as anyone may see it: its roster season by season, and its meets.
 *
 * Read-only on purpose. Editing a roster is the coach's job and lives under
 * Team, behind a membership — this is the page you send someone a link to.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { team: null };
  try {
    return { team: await publicTeamDetail(env.DB, params.teamId) };
  } catch {
    return { team: null };
  }
}

export default function TeamDetail({ loaderData }: Route.ComponentProps) {
  const { team } = loaderData;
  const [seasonId, setSeasonId] = useState<string | null>(null);

  if (!team) {
    return (
      <Card>
        <EmptyState title="Team not found">
          It may have been removed, or the server may be unreachable.
        </EmptyState>
      </Card>
    );
  }

  const season =
    team.seasons.find((s) => s.id === seasonId) ?? team.seasons[0] ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold">{team.name}</h2>
            <p className="text-sm text-slate-500">
              {team.code && <span className="font-mono">{team.code}</span>}
              {team.code && " · "}
              {team.athletes} athlete{team.athletes === 1 ? "" : "s"} ·{" "}
              {team.meets.length} meet{team.meets.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {!team.claimed && (
          <div className="mt-3">
            <Banner tone="warn">
              Nobody has claimed this team yet. If you coach here, sign in and
              ask to join — the first person to ask becomes its head coach.
            </Banner>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Roster</SectionTitle>
        {team.seasons.length === 0 ? (
          <EmptyState title="No seasons yet">A roster appears once a season is set up.</EmptyState>
        ) : (
          <>
            {team.seasons.length > 1 && (
              <div className="mb-3">
                <Segmented
                  value={season?.id ?? ""}
                  onChange={setSeasonId}
                  options={team.seasons.map((s) => ({ value: s.id, label: s.name }))}
                />
              </div>
            )}

            {!season || season.roster.length === 0 ? (
              <EmptyState title="Nobody on this roster">
                Swimmers appear once a coach enrols them.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {season.roster.map((athlete) => (
                  <li key={athlete.id}>
                    <Link
                      to={`/athletes/${athlete.id}`}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate ${
                            athlete.active ? "font-medium" : "text-slate-400 line-through"
                          }`}
                        >
                          {athlete.lastName}, {athlete.firstName}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {[athlete.year, athlete.squad].filter(Boolean).join(" · ") ||
                            "—"}
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
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Meets</SectionTitle>
        {team.meets.length === 0 ? (
          <EmptyState title="No meets yet">Meets appear here once this team races.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {team.meets.map((meet) => (
              <li key={meet.id}>
                <Link
                  to={`/meets/${meet.id}`}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{meet.name}</span>
                    <span className="block text-xs text-slate-500">
                      {meet.date} · {meetTypeLabel(meet.type)} ·{" "}
                      {meet.times} time{meet.times === 1 ? "" : "s"}
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

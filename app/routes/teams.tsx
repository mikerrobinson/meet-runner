import { Link } from "react-router";
import type { Route } from "./+types/teams";
import { BrowseNav } from "~/components/BrowseNav";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { listPublicTeams } from "~/lib/public.server";
import { useAppStore } from "~/state/app-store";
import type { SyncEnv } from "~/lib/api.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Teams · Meet Runner" }];
}

/**
 * Every team this server knows about.
 *
 * Read on the server rather than from the store, because the store only ever
 * holds *your* team — and the whole point of this page is the ones that
 * aren't yours. No account needed: a team's name and size are on every heat
 * sheet already.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { teams: [], offline: true };
  try {
    return { teams: await listPublicTeams(env.DB), offline: false };
  } catch {
    return { teams: [], offline: true };
  }
}

export default function Teams({ loaderData }: Route.ComponentProps) {
  const { teams, offline } = loaderData;
  const { team: mine } = useAppStore();

  const ours = teams.filter((t) => t.id === mine.id);
  const others = teams.filter((t) => t.id !== mine.id);

  return (
    <div className="space-y-4">
      <BrowseNav here="teams" />

      {ours.length > 0 && (
        <Card>
          <SectionTitle>Your team</SectionTitle>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {ours.map((team) => (
              <TeamRow key={team.id} team={team} />
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionTitle>
          {ours.length > 0 ? `Other teams (${others.length})` : `Teams (${teams.length})`}
        </SectionTitle>

        {others.length === 0 ? (
          <EmptyState title={offline ? "Can't reach the server" : "No other teams yet"}>
            {
              offline
                ? "This list lives on the server. Your own team and meets keep working without it."
                : "A team appears here once someone races it — including opponents typed in while setting up a meet."
            }
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {others.map((team) => (
              <TeamRow key={team.id} team={team} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TeamRow({
  team,
}: {
  team: {
    id: string;
    name: string;
    code: string;
    claimed: boolean;
    athletes: number;
    meets: number;
  };
}) {
  return (
    <li>
      <Link
        to={`/teams/${team.id}`}
        className="flex items-center justify-between gap-3 py-3"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{team.name}</span>
            {team.code && (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {team.code}
              </span>
            )}
            {/* Worth saying plainly: an unclaimed team is one anybody may
                still claim, which is how a coach takes over the placeholder
                an opponent created for them. */}
            {!team.claimed && (
              <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                unclaimed
              </span>
            )}
          </span>
          <span className="block text-xs text-slate-500">
            {team.athletes} athlete{team.athletes === 1 ? "" : "s"} · {team.meets}{" "}
            meet{team.meets === 1 ? "" : "s"}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </Link>
    </li>
  );
}

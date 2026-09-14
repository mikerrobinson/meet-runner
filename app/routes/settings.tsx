import { useState } from "react";
import { Form, useFetcher } from "react-router";
import type { Route } from "./+types/settings";
import { AccountPanel } from "~/components/AccountPanel";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Segmented,
  TextInput,
} from "~/components/ui";
import { downloadFile } from "~/lib/csv";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { teamAccess } from "~/lib/access.server";
import { membershipsFor } from "~/lib/auth.server";
import {
  createSeason,
  getTeam,
  listSeasons,
  roster as rosterFor,
  updateTeam,
} from "~/lib/teams.server";
import { dayBefore, nextSeasonName, seasonForDate } from "~/lib/roster";
import { useViewPrefs } from "~/state/view-prefs";
import { todayIso } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Settings · Meet Runner" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  if (!user) return { team: null, seasons: [], season: null, rosterCount: 0 };

  const memberships = (await membershipsFor(db, user.id)).filter(
    (m) => m.status === "active",
  );
  const teamId =
    memberships.find((m) => m.teamId === user.lastTeamId)?.teamId ??
    memberships[0]?.teamId;
  if (!teamId) return { team: null, seasons: [], season: null, rosterCount: 0 };

  const [team, seasons] = await Promise.all([
    getTeam(db, teamId),
    listSeasons(db, teamId),
  ]);
  const season = seasonForDate(seasons, team?.currentSeasonId, todayIso()) ?? null;
  const roster = season ? await rosterFor(db, teamId, season.id) : [];

  return { team, seasons, season, rosterCount: roster.length };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);

  const form = await request.formData();
  const teamId = String(form.get("teamId") ?? "");
  const access = await teamAccess(db, teamId, user);
  if (!access.coach) {
    throw new Response("Only a coach of this team can change that.", { status: 403 });
  }

  const intent = String(form.get("intent") ?? "");

  if (intent === "team") {
    await updateTeam(db, teamId, {
      name: String(form.get("name") ?? ""),
      code: String(form.get("code") ?? ""),
    });
    return { ok: true };
  }

  if (intent === "current-season") {
    await updateTeam(db, teamId, {
      currentSeasonId: String(form.get("seasonId") ?? ""),
    });
    return { ok: true };
  }

  if (intent === "new-season") {
    const name = String(form.get("name") ?? "").trim() || "New season";
    const startDate = String(form.get("startDate") ?? "") || todayIso();
    // The season that was current ends the day before this one starts, so the
    // two never both claim a date — which is what `seasonForDate` reads.
    const previousId = String(form.get("previousId") ?? "");
    if (previousId) {
      await db
        .prepare("UPDATE seasons SET end_date = COALESCE(end_date, ?) WHERE id = ?")
        .bind(dayBefore(startDate), previousId)
        .run();
    }
    const season = await createSeason(db, { teamId, name, startDate });
    await updateTeam(db, teamId, { currentSeasonId: season.id });
    return { ok: true };
  }

  return { ok: false };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { team, seasons, season, rosterCount } = loaderData;
  const { nameOrder, setNameOrder } = useViewPrefs();
  const fetcher = useFetcher();
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <AccountPanel />

      {/* A display preference, and it belongs to whoever is looking rather
          than to the team — a visiting coach shouldn't change how the host
          reads its own roster. */}
      <Card>
        <SectionTitle>Names</SectionTitle>
        <Segmented
          value={nameOrder}
          onChange={(next) => setNameOrder(next as "first" | "last")}
          options={[
            { value: "last", label: "Aaronson, Avery" },
            { value: "first", label: "Avery Aaronson" },
          ]}
        />
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          How names are written and sorted on this device.
        </p>
      </Card>

      {!team ? (
        <Card>
          <EmptyState title="No team yet">
            Sign in and join or start a team to set one up.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <SectionTitle>Team</SectionTitle>
            <fetcher.Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="team" />
              <input type="hidden" name="teamId" value={team.id} />
              <Field label="Name">
                <TextInput name="name" defaultValue={team.name} autoCapitalize="words" />
              </Field>
              <Field label="Code" hint="Short, as it appears on a heat sheet — CHAP.">
                <TextInput name="code" defaultValue={team.code} autoCapitalize="characters" />
              </Field>
              <Button type="submit" variant="primary" full>
                Save team
              </Button>
            </fetcher.Form>
          </Card>

          <Card>
            <SectionTitle
              action={
                <Button size="sm" onClick={() => setAdding((v) => !v)}>
                  {adding ? "Cancel" : "+ Season"}
                </Button>
              }
            >
              Seasons
            </SectionTitle>

            {season && (
              <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
                Working in <strong>{season.name}</strong> — {rosterCount} swimmer
                {rosterCount === 1 ? "" : "s"}.
              </p>
            )}

            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {seasons.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{row.name}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {[row.startDate, row.endDate].filter(Boolean).join(" → ") ||
                        "no dates — covers everything"}
                    </span>
                  </span>
                  {row.id === team.currentSeasonId ? (
                    <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                      current
                    </span>
                  ) : (
                    <fetcher.Form method="post" className="shrink-0">
                      <input type="hidden" name="intent" value="current-season" />
                      <input type="hidden" name="teamId" value={team.id} />
                      <input type="hidden" name="seasonId" value={row.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Make current
                      </Button>
                    </fetcher.Form>
                  )}
                </li>
              ))}
            </ul>

            {adding && (
              <fetcher.Form method="post" className="mt-3 space-y-3">
                <input type="hidden" name="intent" value="new-season" />
                <input type="hidden" name="teamId" value={team.id} />
                <input type="hidden" name="previousId" value={season?.id ?? ""} />
                <Banner tone="info">
                  A new season starts an empty roster. Everyone stays on the old
                  one, so last year&rsquo;s meets keep their names and times.
                </Banner>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name">
                    <TextInput
                      name="name"
                      defaultValue={nextSeasonName(season?.name ?? "")}
                    />
                  </Field>
                  <Field label="Starts">
                    <TextInput type="date" name="startDate" defaultValue={todayIso()} />
                  </Field>
                </div>
                <Button type="submit" variant="primary" full>
                  Start season
                </Button>
              </fetcher.Form>
            )}
          </Card>

          <Card>
            <SectionTitle>Export</SectionTitle>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              The team, its seasons and its roster, as JSON.
            </p>
            <Button
              full
              onClick={() =>
                downloadFile(
                  `${team.code || team.name}-${todayIso()}.json`,
                  JSON.stringify({ team, seasons }, null, 2),
                  "application/json",
                )
              }
            >
              Download team JSON
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}

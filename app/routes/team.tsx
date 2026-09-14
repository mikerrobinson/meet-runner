import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/team";
import { useFetcher } from "react-router";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { teamAccess } from "~/lib/access.server";
import { membershipsFor } from "~/lib/auth.server";
import {
  enrol,
  getTeam,
  listSeasons,
  roster as rosterFor,
} from "~/lib/teams.server";
import { putAthlete } from "~/lib/athletes.server";
import { todayIso } from "~/types/meet";
import { AthleteSheet } from "~/components/AthleteSheet";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { downloadFile, parseRosterCsv, toCsv } from "~/lib/csv";
import { seasonForDate } from "~/lib/roster";
import { allResults } from "~/lib/timing";
import type { RosterEntry } from "~/lib/csv";
import { useViewPrefs } from "~/state/view-prefs";
import {
  byAthlete,
  displayName,
  athleteName,
  type Enrollment,
  type Athlete,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Team · Meet Runner" }];
}

const TEMPLATE = toCsv([
  ["First Name", "Last Name", "Gender", "Year", "Birth Date", "Squad"],
  ["Avery", "Nguyen", "F", "10", "2009-03-14", "Blue"],
  ["Marcus", "Hill", "M", "12", "2007-11-02", "Gold"],
]);

/**
 * The coach's own roster, for the season they're in.
 *
 * Which team that is comes from the account's memberships rather than from
 * whatever a device happened to be holding — a coach signing in on a borrowed
 * iPad gets their own roster, not the last one that touched it.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  if (!user) return { team: null, season: null, roster: [], swimCounts: {} };

  const memberships = (await membershipsFor(db, user.id)).filter(
    (m) => m.status === "active",
  );
  const teamId =
    memberships.find((m) => m.teamId === user.lastTeamId)?.teamId ??
    memberships[0]?.teamId;
  if (!teamId) return { team: null, season: null, roster: [], swimCounts: {} };

  const team = await getTeam(db, teamId);
  const seasons = await listSeasons(db, teamId);
  const season = seasonForDate(seasons, team?.currentSeasonId, todayIso()) ?? null;
  const rows = season ? await rosterFor(db, teamId, season.id) : [];

  // How many meets each swimmer has a time in — one aggregate rather than
  // deriving every result on the client just to count them.
  const { results } = await db
    .prepare(
      `SELECT s.athlete_id AS id, COUNT(DISTINCT w.meet_id) AS n
       FROM seats s JOIN watches w ON w.heat_id = s.heat_id AND w.lane = s.lane
       GROUP BY s.athlete_id`,
    )
    .all<{ id: string; n: number }>();

  return {
    team,
    season,
    roster: rows,
    swimCounts: Object.fromEntries(results.map((r) => [r.id, r.n])),
  };
}

/** Importing a roster, and adding one swimmer at a time. */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);

  const form = await request.formData();
  const teamId = String(form.get("teamId") ?? "");
  const seasonId = String(form.get("seasonId") ?? "");
  const access = await teamAccess(db, teamId, user);
  if (!access.coach) {
    throw new Response("Only a coach of this team can change the roster.", {
      status: 403,
    });
  }

  const entries = JSON.parse(String(form.get("entries") ?? "[]")) as RosterEntry[];
  const mode = String(form.get("mode") ?? "append");

  // "Replace" clears this season's roster and nobody's history: the athletes
  // themselves stay, so past meets keep their names and times. Re-importing
  // used to mint new ids, which left every old entry pointing at somebody who
  // no longer appeared anywhere.
  if (mode === "replace") {
    await db
      .prepare("DELETE FROM enrollments WHERE team_id = ? AND season_id = ?")
      .bind(teamId, seasonId)
      .run();
  }

  for (const entry of entries) {
    const athlete = await putAthlete(db, entry.athlete);
    await enrol(db, {
      teamId,
      seasonId,
      athleteId: athlete.id,
      year: entry.year,
      squad: entry.squad,
    });
  }

  return { ok: true, added: entries.length };
}

export default function Team({ loaderData }: Route.ComponentProps) {
  const { team, season, roster } = loaderData;
  const swimCounts = new Map(Object.entries(loaderData.swimCounts));
  const fetcher = useFetcher();
  const { nameOrder } = useViewPrefs();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<RosterEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const enrolled = roster;
  const active = enrolled.filter((r) => r.enrollment.status === "active");
  const inactive = enrolled.filter((r) => r.enrollment.status !== "active");

  const save = (entries: RosterEntry[], mode: "append" | "replace") => {
    if (!team || !season) return;
    fetcher.submit(
      {
        teamId: team.id,
        seasonId: season.id,
        mode,
        entries: JSON.stringify(entries),
      },
      { method: "post" },
    );
  };

  const handleFile = async (file: File) => {
    const { entries, warnings: issues } = parseRosterCsv(await file.text());
    setWarnings(issues);
    if (entries.length === 0) return;
    if (enrolled.length === 0) save(entries, "replace");
    else setIncoming(entries);
  };

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (showArchived ? enrolled : active)
      .filter((row) => !query || athleteName(row.athlete).toLowerCase().includes(query))
      .sort((a, b) => byAthlete(nameOrder)(a.athlete, b.athlete));
  }, [enrolled, active, showArchived, search, nameOrder]);

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              + Swimmer
            </Button>
          }
        >
          Roster ({active.length})
          {season && (
            <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
              {season.name}
            </span>
          )}
        </SectionTitle>

        {enrolled.length === 0 ? (
          <EmptyState title="No swimmers yet">
            Import a CSV below, or add them one at a time. The roster carries
            across every meet this season.
          </EmptyState>
        ) : (
          <>
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search swimmers"
              className="mb-2"
            />
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {visible.map(({ athlete, enrollment }) => {
                const swims = swimCounts.get(athlete.id) ?? 0;
                const off = enrollment.status !== "active";
                return (
                  <li key={athlete.id}>
                    <Link
                      to={`/athletes/${athlete.id}`}
                      className="flex min-h-14 touch-manipulation items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate font-semibold ${
                            off ? "text-slate-400" : ""
                          }`}
                        >
                          {displayName(athlete, nameOrder)}
                          {off && (
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              off roster
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {athlete.gender}
                          {enrollment.year && ` · ${enrollment.year}`}
                          {enrollment.squad && ` · ${enrollment.squad}`}
                          {swims > 0 &&
                            ` · ${swims} meet${swims === 1 ? "" : "s"}`}
                        </span>
                      </span>
                      <span aria-hidden className="text-xl text-slate-400">
                        ›
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {inactive.length > 0 && (
              <Button
                className="mt-2"
                size="sm"
                variant="ghost"
                full
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived
                  ? "Hide those off the roster"
                  : `Show ${inactive.length} off the roster`}
              </Button>
            )}
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Import roster</SectionTitle>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          CSV with a header row. Columns can be{" "}
          <strong>First Name, Last Name, Gender, Year</strong> — plus optional{" "}
          <strong>Birth Date</strong> and <strong>Squad</strong>. A single{" "}
          <strong>Name</strong> column works too.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" onClick={() => fileInput.current?.click()}>
            Choose CSV
          </Button>
          <Button
            onClick={() =>
              downloadFile("roster-template.csv", TEMPLATE, "text/csv")
            }
          >
            Template
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />

        {incoming && (
          <div className="mt-3 space-y-2">
            <Banner tone="warn">
              {season?.name ?? "This season"} already has {enrolled.length}{" "}
              swimmers. Add the {incoming.length} in this file, or replace the
              roster? Replacing only clears this season&rsquo;s roster — the
              swimmers themselves stay, so past meets keep their names and
              times.
            </Banner>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  save(incoming, "append");
                  setIncoming(null);
                }}
              >
                Add
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  save(incoming, "replace");
                  setIncoming(null);
                }}
              >
                Replace
              </Button>
              <Button onClick={() => setIncoming(null)}>Cancel</Button>
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="mt-3">
            <Banner tone="warn">
              <p className="font-semibold">Import notes</p>
              <ul className="mt-1 list-disc pl-4">
                {warnings.slice(0, 8).map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
                {warnings.length > 8 && <li>…and {warnings.length - 8} more.</li>}
              </ul>
            </Banner>
          </div>
        )}
      </Card>

      {adding && (
        <AthleteSheet
          title="Add swimmer"
          onClose={() => setAdding(false)}
          onSave={(athlete, facts) => {
            save([{ athlete, ...facts }], "append");
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

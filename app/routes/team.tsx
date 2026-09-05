import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/team";
import { SwimmerSheet } from "~/components/SwimmerSheet";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { downloadFile, parseRosterCsv, toCsv } from "~/lib/csv";
import { currentSeason, enrollmentsIn } from "~/lib/roster";
import { allResults } from "~/lib/timing";
import { useAppStore, type RosterEntry } from "~/state/app-store";
import {
  bySwimmer,
  displayName,
  swimmerName,
  type Enrollment,
  type Swimmer,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Team · Meet Runner" }];
}

const TEMPLATE = toCsv([
  ["First Name", "Last Name", "Gender", "Year", "Birth Date", "Squad"],
  ["Avery", "Nguyen", "F", "10", "2009-03-14", "Blue"],
  ["Marcus", "Hill", "M", "12", "2007-11-02", "Gold"],
]);

export default function Team() {
  const { team, meets, enrol } = useAppStore();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<RosterEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** How many meets each swimmer has a time in — shown on the roster row. */
  const swimCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const meet of meets) {
      const seen = new Set<string>();
      for (const result of allResults(meet)) {
        if (seen.has(result.swimmerId)) continue;
        seen.add(result.swimmerId);
        counts.set(result.swimmerId, (counts.get(result.swimmerId) ?? 0) + 1);
      }
    }
    return counts;
  }, [meets]);

  const season = currentSeason(team);
  const enrolled = useMemo(
    () => (season ? enrollmentsIn(team, season.id) : []),
    [team, season],
  );

  const handleFile = async (file: File) => {
    const { entries, warnings: issues } = parseRosterCsv(await file.text());
    setWarnings(issues);
    if (entries.length === 0) return;
    if (enrolled.length === 0) enrol(entries, "replace");
    else setIncoming(entries);
  };

  const byId = useMemo(
    () => new Map(team.swimmers.map((s) => [s.id, s] as const)),
    [team.swimmers],
  );
  const active = enrolled.filter((e) => e.status === "active");
  const inactive = enrolled.filter((e) => e.status !== "active");

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (showArchived ? enrolled : active)
      .map((enrollment) => ({ enrollment, swimmer: byId.get(enrollment.athleteId) }))
      .filter(
        (row): row is { enrollment: Enrollment; swimmer: Swimmer } =>
          row.swimmer !== undefined &&
          (!query || swimmerName(row.swimmer).toLowerCase().includes(query)),
      )
      .sort((a, b) => bySwimmer(team.nameOrder)(a.swimmer, b.swimmer));
  }, [enrolled, active, byId, showArchived, search, team.nameOrder]);

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
              {visible.map(({ swimmer, enrollment }) => {
                const swims = swimCounts.get(swimmer.id) ?? 0;
                const off = enrollment.status !== "active";
                return (
                  <li key={swimmer.id}>
                    <Link
                      to={`/team/${swimmer.id}`}
                      className="flex min-h-14 touch-manipulation items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate font-semibold ${
                            off ? "text-slate-400" : ""
                          }`}
                        >
                          {displayName(swimmer, team.nameOrder)}
                          {off && (
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              off roster
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {swimmer.gender}
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
                  enrol(incoming, "append");
                  setIncoming(null);
                }}
              >
                Add
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  enrol(incoming, "replace");
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
        <SwimmerSheet
          title="Add swimmer"
          onClose={() => setAdding(false)}
          onSave={(swimmer, facts) => {
            enrol([{ athlete: swimmer, ...facts }], "append");
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

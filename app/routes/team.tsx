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
import { useAppStore } from "~/state/app-store";
import {
  bySwimmer,
  displayName,
  swimmerName,
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
  const { team, meets, addSwimmers, updateSwimmer, setArchived } = useAppStore();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<Swimmer[] | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** How many meets each swimmer has a time in — shown on the roster row. */
  const swimCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const meet of meets) {
      const seen = new Set<string>();
      for (const result of meet.results) {
        if (seen.has(result.swimmerId)) continue;
        seen.add(result.swimmerId);
        counts.set(result.swimmerId, (counts.get(result.swimmerId) ?? 0) + 1);
      }
    }
    return counts;
  }, [meets]);

  const handleFile = async (file: File) => {
    const { swimmers, warnings: issues } = parseRosterCsv(await file.text());
    setWarnings(issues);
    if (swimmers.length === 0) return;
    if (team.swimmers.length === 0) addSwimmers(swimmers, "replace");
    else setIncoming(swimmers);
  };

  const active = team.swimmers.filter((s) => !s.archived);
  const archived = team.swimmers.filter((s) => s.archived);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (showArchived ? team.swimmers : active)
      .filter((s) => !query || swimmerName(s).toLowerCase().includes(query))
      .sort(bySwimmer(team.nameOrder));
  }, [team.swimmers, active, showArchived, search, team.nameOrder]);

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
        </SectionTitle>

        {team.swimmers.length === 0 ? (
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
              {visible.map((swimmer) => {
                const swims = swimCounts.get(swimmer.id) ?? 0;
                return (
                  <li key={swimmer.id}>
                    <Link
                      to={`/team/${swimmer.id}`}
                      className="flex min-h-14 touch-manipulation items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate font-semibold ${
                            swimmer.archived ? "text-slate-400" : ""
                          }`}
                        >
                          {displayName(swimmer, team.nameOrder)}
                          {swimmer.archived && (
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              archived
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {swimmer.gender}
                          {swimmer.year && ` · ${swimmer.year}`}
                          {swimmer.squad && ` · ${swimmer.squad}`}
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

            {archived.length > 0 && (
              <Button
                className="mt-2"
                size="sm"
                variant="ghost"
                full
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived
                  ? "Hide archived"
                  : `Show ${archived.length} archived`}
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
              You already have {team.swimmers.length} swimmers. Add the{" "}
              {incoming.length} in this file, or replace the roster? Replacing
              only swaps the roster — entries and times already recorded in past
              meets would then point at swimmers who are no longer listed.
            </Banner>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  addSwimmers(incoming, "append");
                  setIncoming(null);
                }}
              >
                Add
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  addSwimmers(incoming, "replace");
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
          onSave={(swimmer) => {
            addSwimmers([swimmer], "append");
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

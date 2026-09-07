import { useMemo, useState } from "react";
import { useParams } from "react-router";
import type { Route } from "./+types/results";
import { Button, Card, EmptyState, SectionTitle } from "~/components/ui";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { formatTime } from "~/lib/time";
import { enrollmentIndex, seasonForMeet } from "~/lib/roster";
import { allResults, recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import { eventName, athleteName, type Result } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Results · Meet Runner" }];
}

export default function Results() {
  const { team, athletes, meets } = useAppStore();
  const { meetId } = useParams();
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  const meet = meets.find((m) => m.id === meetId);

  // Names come from the roster, so a spelling fixed later shows up here too.
  const byId = useMemo(
    () => new Map(athletes.map((s) => [s.id, s] as const)),
    [athletes],
  );

  // Squad as it was that season, not as it is now.
  const enrollments = useMemo(
    () => enrollmentIndex(team, meet ? seasonForMeet(team, meet)?.id : undefined),
    [team, meet],
  );

  const byEvent = useMemo(() => {
    const map = new Map<string, Result[]>();
    for (const result of meet ? allResults(meet) : []) {
      const list = map.get(result.eventId) ?? [];
      list.push(result);
      map.set(result.eventId, list);
    }
    // Rank across the whole event, not within a heat — DQs and no-shows last.
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.status !== b.status) return a.status === "OK" ? -1 : 1;
        return a.timeMs - b.timeMs;
      });
    }
    return map;
  }, [meet]);

  if (!meet) return null;

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

  if (recordedCount(meet) === 0) {
    return (
      <EmptyState title="No times recorded yet">
        Times show up here as you run heats.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
              downloadFile(
                `${slug}-results.csv`,
                resultsToCsv(meet, team, athletes),
                "text/csv",
              )
            }
          >
            Results CSV
          </Button>
          <Button
            size="lg"
            onClick={() =>
              downloadFile(
                `${slug}.json`,
                JSON.stringify(meet, null, 2),
                "application/json",
              )
            }
          >
            Meet JSON
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {recordedCount(meet)} time{recordedCount(meet) === 1 ? "" : "s"} across{" "}
          {byEvent.size} event{byEvent.size === 1 ? "" : "s"}.
        </p>
      </Card>

      {meet.events.map((event, index) => {
        const results = byEvent.get(event.id) ?? [];
        if (results.length === 0) return null;
        const open = openEvent === event.id;

        return (
          <Card key={event.id}>
            <button
              type="button"
              className="flex w-full touch-manipulation items-center justify-between gap-2 text-left"
              onClick={() => setOpenEvent(open ? null : event.id)}
              aria-expanded={open}
            >
              <span>
                <span className="block text-lg font-bold">
                  {index + 1}. {eventName(event)}
                </span>
                <span className="block text-sm text-slate-500 dark:text-slate-400">
                  {results.length} time{results.length === 1 ? "" : "s"}
                </span>
              </span>
              <span aria-hidden className="text-xl text-slate-400">
                {open ? "▾" : "▸"}
              </span>
            </button>

            {open && (
              <ol className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
                {results.map((result, place) => {
                  const athlete = byId.get(result.athleteId);
                  return (
                    <li
                      key={`${result.heatId}:${result.lane}`}
                      className="flex items-center gap-3 py-2"
                    >
                      <span className="w-6 text-center text-sm font-bold text-slate-400">
                        {result.status === "OK" ? place + 1 : "—"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">
                          {athlete ? athleteName(athlete) : "(removed)"}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          Lane {result.lane}
                          {enrollments.get(result.athleteId)?.squad &&
                            ` · ${enrollments.get(result.athleteId)?.squad}`}
                          {result.manual && " · typed in"}
                        </span>
                      </span>
                      <span className="text-lg font-bold tabular-nums">
                        {result.status === "OK"
                          ? formatTime(result.timeMs)
                          : result.status}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        );
      })}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useParams } from "react-router";
import type { Route } from "./+types/results";
import { Button, Card, EmptyState, SectionTitle } from "~/components/ui";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { formatTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { allResults, recordedCount } from "~/lib/timing";
import { useMeet } from "./meet-layout";
import { useLiveData } from "~/hooks/use-live-data";
import { eventName, athleteName, type Result } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Results · Meet Runner" }];
}

export default function Results() {
  const { detail } = useMeet();
  const meet = detail.meet;
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  // The screen a parent in the stands leaves open. Nothing here is written by
  // this device, so everything on it arrives this way or not at all.
  useLiveData();

  // Names come from the roster, so a spelling fixed later shows up here too.
  const byId = useMemo(
    () => new Map(detail.athletes.map((a) => [a.id, a] as const)),
    [detail.athletes],
  );

  // Squad as it was that season, not as it is now.
  const enrollments = useMemo(
    () => enrollmentIndex(detail.enrollments),
    [detail.enrollments],
  );

  // The racing teams, to turn a swimmer's enrollment into a name. Read from
  // the enrollment rather than from the athlete, because a person belongs to
  // no team — they were enrolled by one, for this meet's season. A swimmer who
  // changes school in March still reads here as whoever they raced for.
  const teamsById = useMemo(
    () => new Map(detail.teams.map((team) => [team.id, team] as const)),
    [detail.teams],
  );

  const byEvent = useMemo(() => {
    const map = new Map<string, Result[]>();
    for (const result of allResults(detail)) {
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
  }, [detail]);

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

  if (recordedCount(detail) === 0) {
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
                resultsToCsv(detail, enrollments),
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
          {recordedCount(detail)} time{recordedCount(detail) === 1 ? "" : "s"}{" "}
          across {byEvent.size} event{byEvent.size === 1 ? "" : "s"}.
        </p>
      </Card>

      {detail.events.map((event, index) => {
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
                  const enrollment = enrollments.get(result.athleteId);
                  const team = enrollment
                    ? teamsById.get(enrollment.teamId)
                    : undefined;
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
                        {/* Team first: in a dual meet the question this
                            screen answers is which school scored, and the lane
                            is only how to find somebody on the deck. The code
                            where there is one — "CACTUS" scans down a column
                            in a way "Cactus Shadows" does not. */}
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {team && `${team.code || team.name} · `}
                          Lane {result.lane}
                          {enrollment?.squad && ` · ${enrollment.squad}`}
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

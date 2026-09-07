import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Route } from "./+types/athlete-detail";
import { AthleteSheet } from "~/components/AthleteSheet";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  SectionTitle,
} from "~/components/ui";
import { formatTime } from "~/lib/time";
import { currentSeason, enrollmentFor } from "~/lib/roster";
import { allResults } from "~/lib/timing";
import { AthleteAccount } from "~/components/AthleteAccount";
import { useAppStore } from "~/state/app-store";
import {
  ageOn,
  eventName,
  meetSubtitle,
  athleteName,
  todayIso,
  type MeetDoc,
  type Result,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Athlete · Meet Runner" }];
}

interface Swim {
  result: Result;
  meet: MeetDoc;
  eventLabel: string;
  /** Place within that event, across all its heats. */
  place: number | null;
  /** True when it's their quickest legal time for this event so far. */
  best: boolean;
}

export default function AthleteDetail() {
  const { team, athletes, meets, saveAthlete, setEnrollmentStatus } =
    useAppStore();
  const { athleteId } = useParams();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const athlete = athletes.find((s) => s.id === athleteId);

  /**
   * Every swim this person has, newest meet first, grouped by event so the
   * screen answers "how's their 100 Free going" rather than just listing times.
   */
  const byEvent = useMemo(() => {
    if (!athlete) return [];

    const swims: Swim[] = [];
    for (const meet of meets) {
      const results = allResults(meet);
      for (const result of results) {
        if (result.athleteId !== athlete.id) continue;
        const event = meet.events.find((e) => e.id === result.eventId);
        if (!event) continue;

        // Place is scored across the whole event, not within a heat.
        const ranked = results
          .filter((r) => r.eventId === event.id && r.status === "OK")
          .sort((a, b) => a.timeMs - b.timeMs);
        const index = ranked.findIndex(
          (r) => r.heatId === result.heatId && r.lane === result.lane,
        );

        swims.push({
          result,
          meet,
          eventLabel: `${event.distance} ${event.stroke}`,
          place: index >= 0 ? index + 1 : null,
          best: false,
        });
      }
    }

    const groups = new Map<string, Swim[]>();
    for (const swim of swims) {
      const list = groups.get(swim.eventLabel) ?? [];
      list.push(swim);
      groups.set(swim.eventLabel, list);
    }

    return [...groups.entries()]
      .map(([label, list]) => {
        const legal = list.filter((s) => s.result.status === "OK");
        const bestMs = legal.length
          ? Math.min(...legal.map((s) => s.result.timeMs))
          : null;
        // Mark only the first swim that matches, so a repeated time doesn't
        // put two "best" badges on the screen.
        let flagged = false;
        const sorted = [...list].sort((a, b) =>
          b.meet.date.localeCompare(a.meet.date),
        );
        for (const swim of sorted) {
          if (
            !flagged &&
            swim.result.status === "OK" &&
            swim.result.timeMs === bestMs
          ) {
            swim.best = true;
            flagged = true;
          }
        }
        return { label, swims: sorted, bestMs };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [athlete, meets]);

  if (!athlete) {
    return (
      <EmptyState title="No such swimmer">
        <Link to="/team" className="font-semibold text-blue-600 underline">
          Back to the roster
        </Link>
      </EmptyState>
    );
  }

  const totalSwims = byEvent.reduce((sum, group) => sum + group.swims.length, 0);
  const age = ageOn(athlete, todayIso());
  const season = currentSeason(team);
  const enrollment = enrollmentFor(team, athlete.id, season?.id);
  const onRoster = enrollment?.status === "active";

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          }
        >
          {athleteName(athlete)}
        </SectionTitle>
        <dl className="grid grid-cols-4 gap-2">
          {[
            { label: "Gender", value: athlete.gender },
            { label: "Year", value: enrollment?.year || "—" },
            { label: "Age", value: age === null ? "—" : String(age) },
            { label: "Squad", value: enrollment?.squad || "—" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl bg-slate-100 p-2 text-center dark:bg-slate-800"
            >
              <dd className="text-lg font-bold">{item.value}</dd>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {item.label}
              </dt>
            </div>
          ))}
        </dl>
        {athlete.birthDate && (
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            Born {athlete.birthDate}
          </p>
        )}
        {!onRoster && (
          <div className="mt-3">
            <Banner tone="warn">
              Not on the {season?.name ?? "current"} roster — hidden from
              registration and lane pickers, but their past results still show
              their name.
            </Banner>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>
          Times ({totalSwims})
        </SectionTitle>
        {byEvent.length === 0 ? (
          <EmptyState title="No times yet">
            Their swims will appear here as meets are run.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {byEvent.map((group) => (
              <div key={group.label}>
                <div className="mb-1 flex items-baseline justify-between">
                  <h3 className="font-bold">{group.label}</h3>
                  {group.bestMs !== null && (
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      best{" "}
                      <strong className="tabular-nums text-slate-900 dark:text-white">
                        {formatTime(group.bestMs)}
                      </strong>
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {group.swims.map((swim) => (
                    <li
                      key={`${swim.meet.id}:${swim.result.heatId}:${swim.result.lane}`}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <Link
                          to={`/meets/${swim.meet.id}/results`}
                          className="block truncate font-semibold text-blue-600 dark:text-blue-400"
                        >
                          {swim.meet.name}
                        </Link>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {swim.meet.date} · {meetSubtitle(swim.meet)}
                          {swim.place && ` · ${ordinal(swim.place)}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {swim.best && group.swims.length > 1 && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                            best
                          </span>
                        )}
                        <span className="text-lg font-bold tabular-nums">
                          {swim.result.status === "OK"
                            ? formatTime(swim.result.timeMs)
                            : swim.result.status}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <AthleteAccount
        athlete={athlete}
        teamId={team.id}
        onLinked={(next) =>
          // Straight through the store so the link is on this device too, and
          // goes up with the next sync like any other edit to a person.
          saveAthlete(next, {
            year: enrollment?.year ?? "",
            squad: enrollment?.squad,
          })
        }
      />

      <Card>
        <SectionTitle>Roster</SectionTitle>
        {!onRoster ? (
          <Button
            full
            onClick={() => setEnrollmentStatus(athlete.id, "active")}
          >
            Add to the {season?.name ?? "current"} roster
          </Button>
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
              Takes them off the {season?.name ?? "current"} roster for new
              meets. Their past results keep working, which is why there's no
              delete.
            </p>
            <Button
              variant="ghost"
              full
              onClick={() => setEnrollmentStatus(athlete.id, "inactive")}
            >
              Take {athleteName(athlete)} off the roster
            </Button>
          </>
        )}
      </Card>

      {editing && (
        <AthleteSheet
          title="Edit swimmer"
          athlete={athlete}
          enrollment={enrollment}
          onClose={() => setEditing(false)}
          onSave={(next, facts) => {
            saveAthlete(next, facts);
            setEditing(false);
          }}
          onDelete={() => {
            setEnrollmentStatus(athlete.id, "inactive");
            setEditing(false);
            navigate("/team");
          }}
          deleteLabel="Take off the roster"
        />
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

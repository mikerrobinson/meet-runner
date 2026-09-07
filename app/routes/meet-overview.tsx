import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Route } from "./+types/meet-overview";
import { Banner, Button, Card, SectionTitle } from "~/components/ui";
import { TimerAccess } from "~/components/TimerAccess";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import { courseLabel, meetSubtitle } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meet · Meet Runner" }];
}

const MODES = [
  { slug: "setup", title: "Setup", detail: "Meet details and event order" },
  {
    slug: "registration",
    title: "Registration",
    detail: "Enter swimmers in events",
  },
  { slug: "run", title: "Run Meet", detail: "Heat-by-heat stopwatch" },
  { slug: "results", title: "Results", detail: "Times and export" },
];

export default function MeetOverview() {
  const { meets, team, athletes, deleteMeet } = useAppStore();
  const { meetId } = useParams();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const meet = meets.find((m) => m.id === meetId);
  if (!meet) return null;

  const entryCount = Object.values(meet.entries).reduce(
    (total, ids) => total + ids.length,
    0,
  );
  const stats = [
    { label: "Events", value: meet.events.length },
    { label: "Entries", value: entryCount },
    { label: "Heats", value: meet.heats.length },
    { label: "Times", value: recordedCount(meet) },
  ];

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            <Link
              to={`/meets/${meet.id}/setup`}
              className="text-sm font-semibold text-blue-600"
            >
              Edit ›
            </Link>
          }
        >
          {meet.name}
        </SectionTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {[
            meetSubtitle(meet),
            meet.date,
            courseLabel(meet.course),
            `${meet.options.laneCount} lanes`,
            meet.location,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        <dl className="mt-4 grid grid-cols-4 gap-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl bg-slate-100 p-2 text-center dark:bg-slate-800"
            >
              <dd className="text-xl font-bold">{stat.value}</dd>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {stat.label}
              </dt>
            </div>
          ))}
        </dl>
      </Card>

      <div className="space-y-2">
        {MODES.map((mode) => (
          <Link
            key={mode.slug}
            to={`/meets/${meet.id}/${mode.slug}`}
            className="flex touch-manipulation items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:active:bg-slate-800"
          >
            <span>
              <span className="block text-lg font-bold">{mode.title}</span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                {mode.detail}
              </span>
            </span>
            <span aria-hidden className="text-2xl text-slate-400">
              ›
            </span>
          </Link>
        ))}
      </div>

      <TimerAccess meet={meet} />

      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={recordedCount(meet) === 0}
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

        <hr className="my-4 border-slate-200 dark:border-slate-800" />

        {confirmDelete ? (
          <div className="space-y-2">
            <Banner tone="error">
              Deleting <strong>{meet.name}</strong> removes its events, entries
              and {recordedCount(meet)} recorded time
              {recordedCount(meet) === 1 ? "" : "s"}. The team roster isn't
              touched. This can't be undone on this device.
            </Banner>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  deleteMeet(meet.id);
                  navigate("/meets");
                }}
              >
                Delete meet
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" full onClick={() => setConfirmDelete(true)}>
            Delete this meet
          </Button>
        )}
      </Card>
    </div>
  );
}

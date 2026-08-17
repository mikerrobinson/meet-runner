import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Route } from "./+types/meet-overview";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Select,
  TextInput,
} from "~/components/ui";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { useAppStore } from "~/state/app-store";
import { MEET_TYPES, type MeetType } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meet · Meet Runner" }];
}

const MODES = [
  { slug: "setup", title: "Setup", detail: "Event order and pool options" },
  {
    slug: "registration",
    title: "Registration",
    detail: "Enter swimmers in events",
  },
  { slug: "run", title: "Run Meet", detail: "Heat-by-heat stopwatch" },
  { slug: "results", title: "Results", detail: "Times and export" },
];

export default function MeetOverview() {
  const { meets, team, setMeetInfo, deleteMeet } = useAppStore();
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
    { label: "Times", value: meet.results.length },
  ];

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Meet details</SectionTitle>
        <div className="space-y-3">
          <Field label="Name">
            <TextInput
              value={meet.name}
              onChange={(e) => setMeetInfo(meet.id, { name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <TextInput
                type="date"
                value={meet.date}
                onChange={(e) => setMeetInfo(meet.id, { date: e.target.value })}
              />
            </Field>
            <Field label="Type">
              <Select
                value={meet.type}
                onChange={(e) =>
                  setMeetInfo(meet.id, { type: e.target.value as MeetType })
                }
              >
                {MEET_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Opponent" hint="Left blank for inter-squad and time trials.">
            <TextInput
              value={meet.opponent ?? ""}
              onChange={(e) =>
                setMeetInfo(meet.id, { opponent: e.target.value || undefined })
              }
              autoCapitalize="words"
            />
          </Field>
        </div>

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

      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={meet.results.length === 0}
            onClick={() =>
              downloadFile(
                `${slug}-results.csv`,
                resultsToCsv(meet, team.swimmers),
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
              and {meet.results.length} recorded time
              {meet.results.length === 1 ? "" : "s"}. The team roster isn't
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

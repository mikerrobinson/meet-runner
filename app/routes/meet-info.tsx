import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Route } from "./+types/meet-info";
import { Banner, Button, Card, SectionTitle } from "~/components/ui";
import { TimerAccess } from "~/components/TimerAccess";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import {
  courseLabel,
  eventName,
  meetSubtitle,
  type MeetDoc,
} from "~/types/meet";
import {
  MeetEventsEditor,
  MeetOptionsEditor,
} from "~/components/MeetSetup";
import { canEditMeet, useMeetRole } from "~/state/meet-role";
import { eventClosed } from "~/lib/timing";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meet · Meet Runner" }];
}

export default function MeetInfo() {
  const { meets, team, athletes, deleteMeet } = useAppStore();
  const { meetId } = useParams();
  const navigate = useNavigate();
  const role = useMeetRole();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  const mayEdit = canEditMeet(role);

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
            mayEdit ? (
              <Button size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Done" : "Edit"}
              </Button>
            ) : undefined
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

      {/* Editing is the same page with controls, not a different screen. A
          reader sees the lineup; whoever runs the meet sees the lineup and can
          change it. */}
      {editing ? (
        <>
          <MeetEventsEditor meet={meet} />
          <MeetOptionsEditor meet={meet} />
        </>
      ) : (
        <EventList meet={meet} />
      )}

      {mayEdit && <TimerAccess meet={meet} />}

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

/**
 * The running order, as a reader sees it.
 *
 * Shows how far along the meet is by marking events official — which is
 * derived from every lane having been signed off, so it can't claim more than
 * the results underneath it.
 */
function EventList({ meet }: { meet: MeetDoc }) {
  if (meet.events.length === 0) {
    return (
      <Card>
        <SectionTitle>Events</SectionTitle>
        <p className="text-sm text-slate-500">No events yet.</p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle>Events ({meet.events.length})</SectionTitle>
      <ol className="divide-y divide-slate-100 dark:divide-slate-800">
        {meet.events.map((event, index) => {
          const entered = (meet.entries[event.id] ?? []).length;
          const official = eventClosed(meet, event.id);
          return (
            <li
              key={event.id}
              className="flex items-center gap-3 py-2 text-sm"
            >
              <span className="w-6 text-right tabular-nums text-slate-400">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {eventName(event)}
              </span>
              {official && (
                <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  official
                </span>
              )}
              <span className="shrink-0 text-xs text-slate-500">
                {entered} entered
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/meets";
import {
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Select,
  Sheet,
  TextInput,
} from "~/components/ui";
import type { MeetPatch } from "~/lib/documents";
import { defaultEvents, dualMeetRaceCount } from "~/lib/events";
import { recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import {
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  courseLabel,
  meetSubtitle,
  meetTypeLabel,
  type LaneCount,
  type MeetCourse,
  type MeetDoc,
  type MeetType,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meets · Meet Runner" }];
}


export default function Meets() {
  const { meets, createMeet } = useAppStore();
  const [adding, setAdding] = useState(false);

  // Newest first — during the season you're nearly always after the next one
  // or the one you just ran.
  const ordered = useMemo(
    () => [...meets].sort((a, b) => b.date.localeCompare(a.date)),
    [meets],
  );

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              + Meet
            </Button>
          }
        >
          Schedule ({meets.length})
        </SectionTitle>

        {meets.length === 0 ? (
          <EmptyState title="No meets yet">
            Add one to set up events, register swimmers, and run it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {ordered.map((meet) => (
              <li key={meet.id}>
                <Link
                  to={`/meets/${meet.id}`}
                  className="flex min-h-16 touch-manipulation items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {meet.name}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {[meet.date, meetSubtitle(meet), meet.course, meet.location]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {summarize(meet)}
                    </span>
                  </span>
                  <span aria-hidden className="text-xl text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adding && (
        <NewMeetSheet
          onClose={() => setAdding(false)}
          onCreate={(patch) => createMeet(patch)}
        />
      )}
    </div>
  );
}

function summarize(meet: MeetDoc): string {
  const entries = Object.values(meet.entries).reduce(
    (total, ids) => total + ids.length,
    0,
  );
  const parts = [
    `${meet.events.length} event${meet.events.length === 1 ? "" : "s"}`,
    `${entries} entr${entries === 1 ? "y" : "ies"}`,
  ];
  const times = recordedCount(meet);
  if (times > 0) parts.push(`${times} time${times === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function NewMeetSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (patch: MeetPatch) => MeetDoc;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<MeetType>("dual");
  const [course, setCourse] = useState<MeetCourse>("SCY");
  const [laneCount, setLaneCount] = useState<LaneCount>(6);
  const [location, setLocation] = useState("");
  const [withDefaults, setWithDefaults] = useState(true);

  // Named after what it is until there are teams to name it after.
  const suggested = meetTypeLabel(type);

  const create = () => {
    const meet = onCreate({
      name: name.trim() || suggested,
      date,
      type,
      course,
      location: location.trim() || undefined,
      options: { laneCount },
      // Most meets swim the same lineup, so start from the standard order
      // rather than an empty setup screen.
      events: withDefaults ? defaultEvents({ course }) : [],
    });
    onClose();
    navigate(`/meets/${meet.id}/setup`);
  };

  return (
    <Sheet open title="New meet" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint={`Leave blank for "${suggested}".`}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested}
            autoCapitalize="words"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as MeetType)}
            >
              {MEET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Course">
            <Select
              value={course}
              onChange={(e) => setCourse(e.target.value as MeetCourse)}
            >
              {MEET_COURSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {courseLabel(c.value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lanes">
            <Select
              value={laneCount}
              onChange={(e) =>
                setLaneCount(Number(e.target.value) as LaneCount)
              }
            >
              {LANE_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Location">
          <TextInput
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Cactus Aquatic Center"
            autoCapitalize="words"
          />
        </Field>

        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            checked={withDefaults}
            onChange={(e) => setWithDefaults(e.target.checked)}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Start with the standard girls/boys order (
            {dualMeetRaceCount(true) * 2} events)
          </span>
        </label>

        <Button variant="primary" size="lg" full onClick={create}>
          Create meet
        </Button>
      </div>
    </Sheet>
  );
}

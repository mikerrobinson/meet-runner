import { useState } from "react";
import { useParams } from "react-router";
import type { Route } from "./+types/setup";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Segmented,
  Select,
} from "~/components/ui";
import { COMMON_DISTANCES, defaultEvents, makeEvent } from "~/lib/events";
import { useAppStore } from "~/state/app-store";
import {
  LANE_COUNTS,
  STROKES,
  eventName,
  orderedLanes,
  type EventGender,
  type LaneCount,
  type LaneLayout,
  type MeetDoc,
  type Stroke,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Setup · Meet Runner" }];
}

type Tab = "events" | "options";

export default function Setup() {
  const { meets } = useAppStore();
  const { meetId } = useParams();
  const [tab, setTab] = useState<Tab>("events");

  const meet = meets.find((m) => m.id === meetId);
  if (!meet) return null;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-xl bg-slate-200 p-1 dark:bg-slate-800">
        {(
          [
            ["events", "Events"],
            ["options", "Options"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`min-h-11 flex-1 touch-manipulation rounded-lg text-base font-semibold transition-colors ${
              tab === value
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "events" && <EventsTab meet={meet} />}
      {tab === "options" && <OptionsTab meet={meet} />}
    </div>
  );
}

/* ------------------------------------------------------------------ events */

function EventsTab({ meet }: { meet: MeetDoc }) {
  const { addEvent, updateEvent, removeEvent, moveEvent, setEvents } =
    useAppStore();
  const [distance, setDistance] = useState(50);
  const [stroke, setStroke] = useState<Stroke>("Free");
  const [gender, setGender] = useState<EventGender>("Open");

  const hasResults = meet.results.length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Event order</SectionTitle>
        {meet.events.length === 0 ? (
          <EmptyState title="No events yet">
            Load a standard dual-meet order below, or add events one at a time.
          </EmptyState>
        ) : (
          <ol className="divide-y divide-slate-200 dark:divide-slate-800">
            {meet.events.map((event, index) => (
              <li key={event.id} className="flex items-center gap-2 py-2">
                <span className="w-7 shrink-0 text-center text-sm font-bold text-slate-400">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{eventName(event)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {(meet.entries[event.id] ?? []).length} entered
                  </p>
                </div>
                <Select
                  aria-label={`Gender for ${eventName(event)}`}
                  value={event.gender}
                  onChange={(e) =>
                    updateEvent(meet.id, event.id, {
                      gender: e.target.value as EventGender,
                    })
                  }
                  className="!w-24 !min-h-10 !text-sm"
                >
                  <option value="Open">Open</option>
                  <option value="F">Girls</option>
                  <option value="M">Boys</option>
                </Select>
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => moveEvent(meet.id, event.id, -1)}
                    className="h-7 w-9 touch-manipulation rounded-t-lg bg-slate-200 text-xs disabled:opacity-30 dark:bg-slate-800"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={index === meet.events.length - 1}
                    onClick={() => moveEvent(meet.id, event.id, 1)}
                    className="h-7 w-9 touch-manipulation rounded-b-lg bg-slate-200 text-xs disabled:opacity-30 dark:bg-slate-800"
                  >
                    ▼
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${eventName(event)}`}
                  onClick={() => removeEvent(meet.id, event.id)}
                  className="h-11 w-9 shrink-0 touch-manipulation rounded-lg text-lg text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card>
        <SectionTitle>Add an event</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Distance">
            <Select
              value={distance}
              onChange={(e) => setDistance(Number(e.target.value))}
            >
              {COMMON_DISTANCES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stroke">
            <Select
              value={stroke}
              onChange={(e) => setStroke(e.target.value as Stroke)}
            >
              {STROKES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gender">
            <Select
              value={gender}
              onChange={(e) => setGender(e.target.value as EventGender)}
            >
              <option value="Open">Open</option>
              <option value="F">Girls</option>
              <option value="M">Boys</option>
            </Select>
          </Field>
        </div>
        <Button
          className="mt-3"
          variant="primary"
          size="lg"
          full
          onClick={() => addEvent(meet.id, makeEvent(distance, stroke, gender))}
        >
          Add {distance} {stroke}
        </Button>
      </Card>

      <Card>
        <SectionTitle>Standard orders</SectionTitle>
        {hasResults && (
          <div className="mb-3">
            <Banner tone="warn">
              Replacing the event list clears recorded times along with it.
            </Banner>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setEvents(meet.id, defaultEvents("open"))}>
            8 open events
          </Button>
          <Button onClick={() => setEvents(meet.id, defaultEvents("split"))}>
            16 girls/boys
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Individual events only — 200 Free, 200 IM, 50 Free, 100 Fly, 100 Free,
          500 Free, 100 Back, 100 Breast.
        </p>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- options */

function OptionsTab({ meet }: { meet: MeetDoc }) {
  const { setLaneCount, setLaneLayout } = useAppStore();
  const { laneCount, laneLayout } = meet.options;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Pool</SectionTitle>
        <Field
          label="Lanes"
          hint="Sets how many swimmers go per heat, and how many buttons the stopwatch shows."
        >
          <Segmented
            value={laneCount}
            onChange={(value) => setLaneCount(meet.id, value as LaneCount)}
            options={LANE_COUNTS.map((n) => ({ value: n, label: String(n) }))}
          />
        </Field>
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Changing the lane count re-seeds heats for any event that hasn't been
          swum yet. Events with recorded times keep their original lanes.
        </p>
      </Card>

      <Card>
        <SectionTitle>Stopwatch buttons</SectionTitle>
        <Field
          label="Layout"
          hint="A single column in pool order is easier to hit without looking — read the finish, drop straight down the column."
        >
          <Segmented
            value={laneLayout}
            onChange={(value) => setLaneLayout(meet.id, value as LaneLayout)}
            options={[
              { value: "grid" as LaneLayout, label: "Grid" },
              { value: "list-asc" as LaneLayout, label: `1 → ${laneCount}` },
              { value: "list-desc" as LaneLayout, label: `${laneCount} → 1` },
            ]}
          />
        </Field>
        <LayoutPreview laneCount={laneCount} layout={laneLayout} />
      </Card>
    </div>
  );
}

/** Miniature of the Run screen's button arrangement, so the choice is visible. */
function LayoutPreview({
  laneCount,
  layout,
}: {
  laneCount: LaneCount;
  layout: LaneLayout;
}) {
  return (
    <div
      className={`mt-3 grid gap-1 ${
        layout === "grid" ? "grid-cols-2" : "grid-cols-1"
      }`}
    >
      {orderedLanes(laneCount, layout).map((lane) => (
        <div
          key={lane}
          className="rounded-md bg-slate-200 py-1 text-center text-xs font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
        >
          Lane {lane}
        </div>
      ))}
    </div>
  );
}

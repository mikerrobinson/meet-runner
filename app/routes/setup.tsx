import { useEffect, useRef, useState } from "react";
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
  TextInput,
} from "~/components/ui";
import {
  RELAY_DISTANCES,
  defaultEvents,
  distancesFor,
  dualMeetRaceCount,
  makeEvent,
  standardOrder,
} from "~/lib/events";
import { recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import {
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  STROKES,
  courseLabel,
  eventName,
  isDiving,
  isRelay,
  type EventGender,
  type Gender,
  type LaneCount,
  type MeetCourse,
  type MeetDoc,
  type MeetEvent,
  type MeetType,
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
  const {
    addEvent,
    removeEvent,
    moveEvent,
    setEvents,
    setIncludeDiving,
    setLeadGender,
  } = useAppStore();
  const [distance, setDistance] = useState(50);
  const [stroke, setStroke] = useState<Stroke>("Free");
  const [gender, setGender] = useState<EventGender>("Open");

  const relay = isRelay({ stroke });
  const distances = relay ? RELAY_DISTANCES : distancesFor(meet.course);
  // Keep the distance valid when switching to or from a relay, so the form
  // can't offer something like a 50 Medley Relay.
  const chosen = distances.includes(distance) ? distance : relay ? 200 : 50;

  const hasResults = recordedCount(meet) > 0;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Event order</SectionTitle>
        {meet.events.length === 0 ? (
          <EmptyState title="No events yet">
            Load a standard dual-meet order below, or add events one at a time.
          </EmptyState>
        ) : (
          <EventOrder
            meet={meet}
            onReorder={(events) => setEvents(meet.id, events)}
            onNudge={(eventId, direction) =>
              moveEvent(meet.id, eventId, direction)
            }
            onRemove={(eventId) => removeEvent(meet.id, eventId)}
          />
        )}
      </Card>

      <Card>
        <SectionTitle>Add an event</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Distance">
            <Select
              value={chosen}
              onChange={(e) => setDistance(Number(e.target.value))}
            >
              {distances.map((d) => (
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
          onClick={() => addEvent(meet.id, makeEvent(chosen, stroke, gender))}
        >
          Add {chosen} {stroke}
        </Button>
        {relay && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Relays are timed like any other event — one clock per lane. Put one
            athlete in each relay's lane to stand for the squad; the four legs
            aren&rsquo;t tracked separately.
          </p>
        )}
      </Card>

      <Card>
        <SectionTitle>Diving</SectionTitle>
        <Field
          label="Diving event"
          hint="Adds Diving to the order so divers can see it on the registration grid alongside their swims. It isn't scored or timed here — move or remove it like any other event."
        >
          <Segmented
            value={meet.options.includeDiving ? "yes" : "no"}
            onChange={(value) => setIncludeDiving(meet.id, value === "yes")}
            options={[
              { value: "yes", label: "Include" },
              { value: "no", label: "Leave out" },
            ]}
          />
        </Field>
      </Card>

      <Card>
        <SectionTitle>Running order</SectionTitle>
        <Field
          label="First in each pair"
          hint="Flips the whole lineup at once. Events keep their entries and times — it's a reorder, not a rebuild."
        >
          <Segmented
            value={meet.options.leadGender}
            onChange={(value) => setLeadGender(meet.id, value as Gender)}
            options={[
              { value: "F" as Gender, label: "Girls first" },
              { value: "M" as Gender, label: "Boys first" },
            ]}
          />
        </Field>
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
          <Button
            variant="primary"
            onClick={() =>
              setEvents(
                meet.id,
                defaultEvents({
                  leadGender: meet.options.leadGender,
                  includeDiving: meet.options.includeDiving,
                  course: meet.course,
                }),
              )
            }
          >
            Girls &amp; boys (
            {dualMeetRaceCount(meet.options.includeDiving) * 2})
          </Button>
          <Button
            onClick={() =>
              setEvents(
                meet.id,
                defaultEvents({
                  mode: "open",
                  includeDiving: meet.options.includeDiving,
                  course: meet.course,
                }),
              )
            }
          >
            Open ({dualMeetRaceCount(meet.options.includeDiving)})
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The usual dual-meet order:{" "}
          {standardOrder(meet.course, meet.options.includeDiving)
            .map((e) => (isDiving(e) ? "Diving" : `${e.distance} ${e.stroke}`))
            .join(", ")}
          . &ldquo;Open&rdquo; swims each once, for an inter-squad meet or a
          time trial.
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ event order */

/**
 * The running order, reorderable by dragging the handle on the left.
 *
 * Pointer events rather than HTML5 drag-and-drop, which doesn't fire on touch
 * at all — and this list is mostly used on an iPad. The handle sits on the
 * opposite side from the delete button so a mis-grab can't cost an event, and
 * carries `touch-action: none` so a drag doesn't scroll the page instead.
 *
 * The handle is still a button: arrow keys move an event without dragging,
 * which keeps it usable from a keyboard and by anyone who can't drag.
 */
function EventOrder({
  meet,
  onReorder,
  onNudge,
  onRemove,
}: {
  meet: MeetDoc;
  onReorder: (events: MeetEvent[]) => void;
  onNudge: (eventId: string, direction: -1 | 1) => void;
  onRemove: (eventId: string) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  // While a drag is in flight the list follows the pointer locally; the store
  // hears about it once, on drop, rather than on every crossing.
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<MeetEvent[] | null>(null);
  const orderRef = useRef<MeetEvent[] | null>(null);

  const events = order ?? meet.events;

  /**
   * Tracking happens on the window, bound the moment the drag starts.
   *
   * Pointer capture looks like the right tool and isn't: reordering moves the
   * dragged row's DOM node, and moving a node releases its capture — after
   * which the drop lands somewhere else and the drag never ends. Binding here
   * rather than in an effect also means a quick flick can't slip through the
   * gap before the next render.
   */
  const detachRef = useRef<(() => void) | null>(null);

  const startDrag = (eventId: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(eventId);
    setOrder(meet.events);
    orderRef.current = meet.events;

    const move = (moveEvent: PointerEvent) => {
      const current = orderRef.current;
      if (!current || !listRef.current) return;

      const rows = [...listRef.current.children] as HTMLElement[];
      const from = current.findIndex((event) => event.id === eventId);
      // Measured rather than assumed: rows aren't all the same height.
      const to = rows.findIndex((row) => {
        const box = row.getBoundingClientRect();
        return moveEvent.clientY >= box.top && moveEvent.clientY <= box.bottom;
      });
      if (to < 0 || from < 0 || to === from) return;

      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      orderRef.current = next;
      setOrder(next);
    };

    const finish = (commit: boolean) => {
      detachRef.current?.();
      const current = orderRef.current;
      if (commit && current) {
        const changed = current.some(
          (event, i) => event.id !== meet.events[i]?.id,
        );
        if (changed) onReorder(current);
      }
      orderRef.current = null;
      setDragging(null);
      setOrder(null);
    };

    const drop = () => finish(true);
    const cancel = () => finish(false);
    const onKey = (key: KeyboardEvent) => {
      if (key.key === "Escape") cancel();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    detachRef.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      detachRef.current = null;
    };
  };

  // A drag interrupted by navigating away shouldn't leave listeners behind.
  useEffect(() => () => detachRef.current?.(), []);

  return (
    <ol ref={listRef} className="divide-y divide-slate-200 dark:divide-slate-800">
      {events.map((event, index) => {
        const entries = (meet.entries[event.id] ?? []).length;
        const held = dragging === event.id;
        return (
          <li
            key={event.id}
            // Lifted off the page while held: slightly larger, and a shadow
            // thrown evenly rather than downward, so it reads as picked up
            // rather than as the row below it having moved. `z-10` keeps it
            // above the dividing lines it now overlaps.
            className={`flex items-center gap-2 py-2 transition duration-150 ${
              held
                ? "relative z-10 scale-[1.03] rounded-xl bg-white shadow-[0_0_18px_rgba(15,23,42,0.28)] dark:bg-slate-800 dark:shadow-[0_0_18px_rgba(0,0,0,0.65)]"
                : dragging
                  ? "opacity-60"
                  : ""
            }`}
          >
            <button
              type="button"
              aria-label={`Reorder ${eventName(event)}`}
              onPointerDown={startDrag(event.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" && index > 0) {
                  e.preventDefault();
                  onNudge(event.id, -1);
                } else if (e.key === "ArrowDown" && index < events.length - 1) {
                  e.preventDefault();
                  onNudge(event.id, 1);
                }
              }}
              className="h-11 w-8 shrink-0 cursor-grab touch-none text-lg leading-none text-slate-400 active:cursor-grabbing"
            >
              ⠿
            </button>
            <span className="w-6 shrink-0 text-center text-sm font-bold text-slate-400">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{eventName(event)}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {entries}
                {entries === 1 ? " entry" : " entries"}
              </p>
            </div>
            <button
              type="button"
              aria-label={`Remove ${eventName(event)}`}
              onClick={() => onRemove(event.id)}
              className="h-11 w-9 shrink-0 touch-manipulation rounded-lg text-lg text-red-600"
            >
              ✕
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------------------------------------------- options */

function OptionsTab({ meet }: { meet: MeetDoc }) {
  const { setMeetInfo, setCourse, setLaneCount, team } = useAppStore();
  const { laneCount } = meet.options;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Meet details</SectionTitle>
        <div className="space-y-3">
          <Field label="Name">
            <TextInput
              value={meet.name}
              onChange={(e) => setMeetInfo(meet.id, { name: e.target.value })}
              autoCapitalize="words"
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
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Course"
              hint="Switching between yards and metres converts the lineup: the 500 free becomes a 400, the mile the metric mile."
            >
              <Select
                value={meet.course}
                onChange={(e) =>
                  setCourse(meet.id, e.target.value as MeetCourse)
                }
              >
                {MEET_COURSES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {courseLabel(c.value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Lanes"
              hint="Re-seeds heats for anything not yet swum."
            >
              <Select
                value={laneCount}
                onChange={(e) =>
                  setLaneCount(meet.id, Number(e.target.value) as LaneCount)
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
              value={meet.location ?? ""}
              onChange={(e) =>
                setMeetInfo(meet.id, { location: e.target.value || undefined })
              }
              placeholder="Cactus Aquatic Center"
              autoCapitalize="words"
            />
          </Field>
        </div>
      </Card>
    </div>
  );
}

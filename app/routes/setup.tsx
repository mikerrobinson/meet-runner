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
    updateEvent,
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
          <ol className="divide-y divide-slate-200 dark:divide-slate-800">
            {meet.events.map((event, index) => (
              <li key={event.id} className="flex items-center gap-2 py-2">
                <span className="w-7 shrink-0 text-center text-sm font-bold text-slate-400">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    {eventName(event)}
                    {isRelay(event) && (
                      <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">
                        relay
                      </span>
                    )}
                    {isDiving(event) && (
                      <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                        not timed here
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {(meet.entries[event.id] ?? []).length}{" "}
                    {isRelay(event) ? "lanes filled" : "entered"}
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
            swimmer in each relay's lane to stand for the squad; the four legs
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

/* ----------------------------------------------------------------- options */

function OptionsTab({ meet }: { meet: MeetDoc }) {
  const { setMeetInfo, setCourse, setLaneCount } = useAppStore();
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

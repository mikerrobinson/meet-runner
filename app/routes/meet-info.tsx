import { useState } from "react";
import { Form, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/meet-info";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Select,
  TextInput,
} from "~/components/ui";
import { TimerAccess } from "~/components/TimerAccess";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { eventClosed, recordedCount } from "~/lib/timing";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { mayEditMeet } from "~/lib/access";
import { meetAccess } from "~/lib/access.server";
import {
  addEvent,
  addEventsToMeet,
  deleteMeet,
  removeEvent,
  setEventOrder,
  updateMeet,
} from "~/lib/meets.server";
import { renumber, withDiving, withoutDiving } from "~/lib/events";
import { useMeet } from "./meet-layout";
import {
  courseLabel,
  eventName,
  isLaneCount,
  isMeetCourse,
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  meetSubtitle,
  STROKES,
  type EventGender,
  type LaneCount,
  type MeetType,
  type Stroke,
} from "~/types/meet";

/**
 * Everything that changes a meet, behind one check.
 *
 * `mayEditMeet` is asked here, against the same request that loaded the rows —
 * so the screen and the server cannot disagree about whether you run this
 * meet. The old split, where the page rendered from a local copy and asked a
 * separate endpoint about permissions, is what hid the Edit button on meets
 * their own creator had made.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  const access = await meetAccess(db, params.meetId, user);
  if (!mayEditMeet(access)) {
    throw new Response("Whoever is running this meet decides that.", { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "details") {
    const lanes = Number(form.get("laneCount"));
    const course = form.get("course");
    await updateMeet(db, params.meetId, {
      name: String(form.get("name") ?? "").trim() || "Meet",
      date: String(form.get("date") ?? ""),
      type: String(form.get("type") ?? "dual") as MeetType,
      course: isMeetCourse(course) ? course : "SCY",
      location: String(form.get("location") ?? "").trim(),
      laneCount: isLaneCount(lanes) ? lanes : 6,
    });
    return { ok: true };
  }

  if (intent === "add-event") {
    await addEvent(db, params.meetId, {
      distance: Number(form.get("distance")) || 50,
      stroke: String(form.get("stroke") ?? "Free") as Stroke,
      gender: String(form.get("gender") ?? "Open") as EventGender,
    });
    return { ok: true };
  }

  if (intent === "remove-event") {
    await removeEvent(db, String(form.get("eventId")));
    return { ok: true };
  }

  if (intent === "reorder") {
    await setEventOrder(db, form.getAll("eventId").map(String));
    return { ok: true };
  }

  if (intent === "diving") {
    // The lineup is the truth about diving; the option just reports it.
    const on = form.get("includeDiving") === "on";
    const events = JSON.parse(String(form.get("events"))) as Parameters<
      typeof addEventsToMeet
    >[2];
    const next = on
      ? withDiving(params.meetId, events, form.get("leadGender") === "M" ? "M" : "F")
      : withoutDiving(events);
    await updateMeet(db, params.meetId, { includeDiving: on });
    // Only the diving rows change; everything else keeps its id and position.
    const added = next.filter((e) => !events.some((o) => o.id === e.id));
    const gone = events.filter((e) => !next.some((o) => o.id === e.id));
    for (const event of gone) await removeEvent(db, event.id);
    if (added.length) await addEventsToMeet(db, params.meetId, added);
    await setEventOrder(db, renumber(next).map((e) => e.id));
    return { ok: true };
  }

  if (intent === "delete") {
    await deleteMeet(db, params.meetId);
    return redirect("/meets");
  }

  return { ok: false };
}

export default function MeetInfo() {
  const { detail, access } = useMeet();
  const { meet, events, entries, heats } = detail;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mayEdit = mayEditMeet(access);

  const entryCount = Object.values(entries).reduce((n, ids) => n + ids.length, 0);
  const times = recordedCount(detail);
  const stats = [
    { label: "Events", value: events.length },
    { label: "Entries", value: entryCount },
    { label: "Heats", value: heats.length },
    { label: "Times", value: times },
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
            `${meet.laneCount} lanes`,
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
      {editing && <DetailsEditor />}
      <EventList editing={editing} />

      {mayEdit && <TimerAccess meet={meet} />}

      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={times === 0}
            onClick={() =>
              downloadFile(`${slug}-results.csv`, resultsToCsv(detail), "text/csv")
            }
          >
            Results CSV
          </Button>
          <Button
            onClick={() =>
              downloadFile(
                `${slug}.json`,
                JSON.stringify(detail, null, 2),
                "application/json",
              )
            }
          >
            Meet JSON
          </Button>
        </div>

        {mayEdit && (
          <>
            <hr className="my-4 border-slate-200 dark:border-slate-800" />
            {confirmDelete ? (
              <div className="space-y-2">
                <Banner tone="error">
                  Deleting <strong>{meet.name}</strong> removes its events,
                  entries and {times} recorded time{times === 1 ? "" : "s"}. The
                  team roster isn&rsquo;t touched. This can&rsquo;t be undone.
                </Banner>
                <div className="grid grid-cols-2 gap-2">
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <Button type="submit" variant="danger" full>
                      Delete meet
                    </Button>
                  </Form>
                  <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" full onClick={() => setConfirmDelete(true)}>
                Delete this meet
              </Button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/** Name, date, type, course, lanes, location — one form, one write. */
function DetailsEditor() {
  const { detail } = useMeet();
  const { meet } = detail;
  const fetcher = useFetcher();

  return (
    <Card>
      <SectionTitle>Details</SectionTitle>
      <fetcher.Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="details" />
        <Field label="Name">
          <TextInput name="name" defaultValue={meet.name} autoCapitalize="words" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" name="date" defaultValue={meet.date} />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue={meet.type}>
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
            <Select name="course" defaultValue={meet.course}>
              {MEET_COURSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {courseLabel(c.value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lanes">
            <Select name="laneCount" defaultValue={meet.laneCount}>
              {LANE_COUNTS.map((n: LaneCount) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Location">
          <TextInput
            name="location"
            defaultValue={meet.location ?? ""}
            autoCapitalize="words"
          />
        </Field>
        <Button type="submit" variant="primary" full>
          {fetcher.state === "submitting" ? "Saving…" : "Save details"}
        </Button>
      </fetcher.Form>
    </Card>
  );
}

/**
 * The running order.
 *
 * Read-only it shows how far along the meet is, marking events official —
 * derived from every lane having been signed off, so it can't claim more than
 * the calls underneath it. Editing adds the controls in place.
 */
function EventList({ editing }: { editing: boolean }) {
  const { detail } = useMeet();
  const { events, entries } = detail;
  const fetcher = useFetcher();

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= events.length) return;
    const order = events.map((e) => e.id);
    [order[index], order[target]] = [order[target], order[index]];
    const data = new FormData();
    data.set("intent", "reorder");
    for (const id of order) data.append("eventId", id);
    fetcher.submit(data, { method: "post" });
  };

  return (
    <Card>
      <SectionTitle>Events ({events.length})</SectionTitle>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No events yet.</p>
      ) : (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {events.map((event, index) => {
            const entered = (entries[event.id] ?? []).length;
            const official = eventClosed(detail, event.id);
            return (
              <li key={event.id} className="flex items-center gap-2 py-2 text-sm">
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
                {editing && (
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => move(index, -1)}>
                      ↑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => move(index, 1)}>
                      ↓
                    </Button>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="remove-event" />
                      <input type="hidden" name="eventId" value={event.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        title={
                          official
                            ? "This event has official results — removing it discards them."
                            : "Remove this event"
                        }
                      >
                        ✕
                      </Button>
                    </fetcher.Form>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <fetcher.Form method="post" className="mt-3 flex items-end gap-2">
          <input type="hidden" name="intent" value="add-event" />
          <Field label="Distance">
            <TextInput
              name="distance"
              type="number"
              defaultValue={50}
              inputMode="numeric"
              className="w-20"
            />
          </Field>
          <Field label="Stroke">
            <Select name="stroke" defaultValue="Free">
              {STROKES.map((stroke) => (
                <option key={stroke} value={stroke}>
                  {stroke}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gender">
            <Select name="gender" defaultValue="F">
              <option value="F">Girls</option>
              <option value="M">Boys</option>
              <option value="Open">Open</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary">
            Add
          </Button>
        </fetcher.Form>
      )}
    </Card>
  );
}

import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/meets";
import {
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Segmented,
  Select,
  Sheet,
  TextInput,
} from "~/components/ui";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { membershipsFor } from "~/lib/auth.server";
import { createMeet, listMeets, type MeetSummary } from "~/lib/meets.server";
import { addMeetAdmin } from "~/lib/admins.server";
import { defaultEvents, dualMeetRaceCount } from "~/lib/events";
import { addEventsToMeet } from "~/lib/meets.server";
import { useSession } from "~/state/session";
import {
  courseLabel,
  isLaneCount,
  isMeetCourse,
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  meetTypeLabel,
  todayIso,
  type LaneCount,
  type MeetCourse,
  type MeetType,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meets · Meet Runner" }];
}

type Filter = "upcoming" | "complete" | "all";

/**
 * Every meet, from one place.
 *
 * There used to be two sources here — the meets this device held, and the ones
 * the server knew about — merged on the client with a badge saying which was
 * which. A reader had to understand the difference to understand the list.
 * There is one copy of a meet now, so there is one list.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  return { meets: await listMeets(db) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  if (!user) throw new Response("Sign in to create a meet", { status: 403 });

  const form = await request.formData();
  const type = String(form.get("type") ?? "dual") as MeetType;
  const course = form.get("course");
  const lanes = Number(form.get("laneCount"));
  const name = String(form.get("name") ?? "").trim();

  // The teams this person coaches are the ones the meet starts with. A meet
  // belongs to none of them; this just saves picking your own school from a
  // list every time.
  const memberships = await membershipsFor(db, user.id);
  const teamIds = memberships
    .filter((m) => m.status === "active")
    .map((m) => m.teamId);

  const meet = await createMeet(db, {
    name: name || meetTypeLabel(type),
    date: String(form.get("date") ?? todayIso()),
    type,
    course: isMeetCourse(course) ? course : "SCY",
    location: String(form.get("location") ?? "").trim() || undefined,
    teamIds,
    hostTeamId: teamIds[0],
    createdBy: user.id,
    laneCount: isLaneCount(lanes) ? lanes : 6,
    includeDiving: true,
    limits: { maxIndividual: 2, maxRelays: 2, maxTotal: 4 },
  });

  // Whoever sets a meet up runs it. Recorded here, at the moment of creation,
  // rather than inferred later from who happened to push it first.
  await addMeetAdmin(db, meet.id, user.id, user.id);

  // Most meets swim the same lineup, so start from the standard order rather
  // than an empty setup screen.
  if (form.get("withDefaults") === "on") {
    await addEventsToMeet(
      db,
      meet.id,
      defaultEvents(meet.id, { course: meet.course }),
    );
  }

  return redirect(`/meets/${meet.id}`);
}

function isUpcoming(date: string, today: string): boolean {
  return date >= today;
}

function summarize(row: MeetSummary): string {
  const parts = [
    `${row.eventCount} event${row.eventCount === 1 ? "" : "s"}`,
    `${row.entryCount} entr${row.entryCount === 1 ? "y" : "ies"}`,
  ];
  if (row.timedLanes > 0) {
    parts.push(`${row.timedLanes} time${row.timedLanes === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

export default function Meets({ loaderData }: Route.ComponentProps) {
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const today = todayIso();

  const counts = {
    upcoming: loaderData.meets.filter((r) => isUpcoming(r.meet.date, today)).length,
    complete: loaderData.meets.filter((r) => !isUpcoming(r.meet.date, today)).length,
    all: loaderData.meets.length,
  };

  const visible = loaderData.meets
    .filter((row) =>
      filter === "all"
        ? true
        : filter === "upcoming"
          ? isUpcoming(row.meet.date, today)
          : !isUpcoming(row.meet.date, today),
    )
    // The next meet first when looking forward; the last one first when
    // looking back. Both are "nearest to now", which is what you came for.
    .sort((a, b) =>
      filter === "upcoming"
        ? a.meet.date.localeCompare(b.meet.date)
        : b.meet.date.localeCompare(a.meet.date),
    );

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            session.status === "in" ? (
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                + Meet
              </Button>
            ) : undefined
          }
        >
          Meets
        </SectionTitle>

        <div className="mb-3">
          <Segmented
            value={filter}
            onChange={(next) => setFilter(next as Filter)}
            options={[
              { value: "upcoming", label: `Upcoming (${counts.upcoming})` },
              { value: "complete", label: `Complete (${counts.complete})` },
              { value: "all", label: `All (${counts.all})` },
            ]}
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title={
              filter === "upcoming"
                ? "Nothing coming up"
                : filter === "complete"
                  ? "Nothing swum yet"
                  : "No meets yet"
            }
          >
            {session.status === "in"
              ? "Add one to set up events, register swimmers, and run it."
              : "Sign in to set one up."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {visible.map((row) => (
              <li key={row.meet.id}>
                <Link
                  to={`/meets/${row.meet.id}`}
                  className="flex min-h-16 touch-manipulation items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="truncate font-semibold">{row.meet.name}</span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {[
                        row.meet.date,
                        meetTypeLabel(row.meet.type),
                        row.meet.course,
                        row.teams.map((t) => t.code || t.name).join(" v "),
                        row.meet.location,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {summarize(row)}
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

      {adding && <NewMeetSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

/**
 * Setting one up.
 *
 * A plain form posting to this route's action. The fields that were React
 * state are inputs with names now; the only state left is the one thing the
 * form itself needs to know, which is what to suggest as a name.
 */
function NewMeetSheet({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<MeetType>("dual");
  const [course, setCourse] = useState<MeetCourse>("SCY");
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  // Named after what it is until there are teams to name it after.
  const suggested = meetTypeLabel(type);

  return (
    <Sheet open title="New meet" onClose={onClose}>
      <Form method="post" className="space-y-3">
        <Field label="Name" hint={`Leave blank for "${suggested}".`}>
          <TextInput name="name" placeholder={suggested} autoCapitalize="words" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" name="date" defaultValue={todayIso()} />
          </Field>
          <Field label="Type">
            <Select
              name="type"
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
              name="course"
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
            <Select name="laneCount" defaultValue={6}>
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
            placeholder="Cactus Aquatic Center"
            autoCapitalize="words"
          />
        </Field>

        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            name="withDefaults"
            defaultChecked
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Start with the standard girls/boys order (
            {dualMeetRaceCount(true) * 2} events)
          </span>
        </label>

        <Button type="submit" variant="primary" size="lg" full disabled={saving}>
          {saving ? "Creating…" : "Create meet"}
        </Button>
      </Form>
    </Sheet>
  );
}

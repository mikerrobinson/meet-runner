import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/meets";
import { listPublicMeets } from "~/lib/public.server";
import type { SyncEnv } from "~/lib/api.server";
import {
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Select,
  Segmented,
  Sheet,
  TextInput,
} from "~/components/ui";
import type { MeetPatch } from "~/lib/documents";
import { defaultEvents, dualMeetRaceCount } from "~/lib/events";
import { recordedCount } from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import { useSession } from "~/state/session";
import {
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  courseLabel,
  meetSubtitle,
  meetTypeLabel,
  todayIso,
  type LaneCount,
  type MeetCourse,
  type MeetDoc,
  type MeetType,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meets · Meet Runner" }];
}

/**
 * Everything the server holds, so this page can show meets this device
 * doesn't. Failing quietly is deliberate: the schedule below comes from local
 * storage and has to render on a pool deck with no signal.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { elsewhere: [] };
  try {
    return { elsewhere: await listPublicMeets(env.DB) };
  } catch {
    return { elsewhere: [] };
  }
}

type Filter = "upcoming" | "complete" | "all";

/** One line in the schedule, whether it came from this device or the server. */
interface Row {
  id: string;
  name: string;
  date: string;
  subtitle: string;
  detail: string;
  /** Held on this device, so it works with no signal and can be run. */
  local: boolean;
}

/**
 * Upcoming or complete, decided by the date.
 *
 * Deliberately not "has all its results signed off": a meet that was swum but
 * never fully accepted is still in the past, and a schedule that kept it under
 * "upcoming" for months would be lying about the calendar. Whether the results
 * are official is a question the meet's own page answers.
 */
function isUpcoming(date: string, today: string): boolean {
  return date >= today;
}

export default function Meets({ loaderData }: Route.ComponentProps) {
  const { meets, createMeet } = useAppStore();
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const today = todayIso();

  /**
   * The schedule, from both sides at once.
   *
   * Local first and never blocking on the network: a coach opening this at a
   * pool with dead wifi has to see their own meets immediately, because that
   * is the situation the app exists for. Whatever the server knows is merged
   * in when it arrives, and a meet held on this device wins — its copy is the
   * one that can actually be run.
   */
  const rows = useMemo<Row[]>(() => {
    const mine = new Set(meets.map((m) => m.id));

    const local: Row[] = meets.map((meet) => ({
      id: meet.id,
      name: meet.name,
      date: meet.date,
      subtitle: [meetSubtitle(meet), meet.course, meet.location]
        .filter(Boolean)
        .join(" · "),
      detail: summarize(meet),
      local: true,
    }));

    const remote: Row[] = loaderData.elsewhere
      .filter((meet) => !mine.has(meet.id))
      .map((meet) => ({
        id: meet.id,
        name: meet.name,
        date: meet.date,
        subtitle: [
          meetTypeLabel(meet.type),
          meet.course,
          meet.teams.map((t) => t.code || t.name).join(" v "),
        ]
          .filter(Boolean)
          .join(" · "),
        detail: `${meet.events} event${meet.events === 1 ? "" : "s"} · ${meet.entries} entr${meet.entries === 1 ? "y" : "ies"}${meet.times > 0 ? ` · ${meet.times} time${meet.times === 1 ? "" : "s"}` : ""}`,
        local: false,
      }));

    return [...local, ...remote];
  }, [meets, loaderData.elsewhere]);

  const visible = useMemo(() => {
    const matching = rows.filter((row) =>
      filter === "all"
        ? true
        : filter === "upcoming"
          ? isUpcoming(row.date, today)
          : !isUpcoming(row.date, today),
    );
    // The next meet first when looking forward; the last one first when
    // looking back. Both are "nearest to now", which is what you came for.
    const ascending = filter === "upcoming";
    return matching.sort((a, b) =>
      ascending ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date),
    );
  }, [rows, filter, today]);

  const counts = useMemo(
    () => ({
      upcoming: rows.filter((r) => isUpcoming(r.date, today)).length,
      complete: rows.filter((r) => !isUpcoming(r.date, today)).length,
      all: rows.length,
    }),
    [rows, today],
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
              <li key={row.id}>
                <Link
                  to={`/meets/${row.id}`}
                  className="flex min-h-16 touch-manipulation items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{row.name}</span>
                      {!row.local && (
                        <span
                          className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                          title="On the server. Open it to read; it isn't on this device."
                        >
                          elsewhere
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {[row.date, row.subtitle].filter(Boolean).join(" · ")}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {row.detail}
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
    navigate(`/meets/${meet.id}`);
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

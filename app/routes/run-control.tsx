import { useMemo, useState } from "react";
import { Button, Card, EmptyState, SectionTitle, TextInput } from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex, rosterForMeet, seasonForMeet } from "~/lib/roster";
import {
  acceptedForLane,
  activeLanes,
  attributedAthlete,
  eventClosed,
  heatClosed,
  heatProgress,
  watchesForLane,
  officialTime,
  resultForLane,
  rulingForLane,
} from "~/lib/timing";
import { useAppStore } from "~/state/app-store";
import { useSession } from "~/state/session";
import { useViewPrefs } from "~/state/view-prefs";
import {
  athleteName,
  displayName,
  eventName,
  findAthlete,
  type Heat,
  type MeetDoc,
  type MeetEvent,
  type ResultStatus,
} from "~/types/meet";

/**
 * The desk the meet is run from.
 *
 * Not a stopwatch — the coaches and timers have those. This is the screen
 * somebody sits behind with the running order in front of them, watching times
 * arrive from three phones on a lane and deciding what stands. Nothing here is
 * a race against the clock, so it's dense and readable rather than big and
 * thumb-shaped: an administrator is at a table with a tablet, not on the
 * blocks with a phone.
 *
 * Everything it shows is derived. The watches are what the timers sent, the
 * proposed time is what those work out to, and "official" means every lane
 * that swam has been signed off — so nothing on this screen can disagree with
 * anything else in the meet.
 */
export function RunControl({ meet }: { meet: MeetDoc }) {
  const store = useAppStore();
  const session = useSession();
  const { nameOrder } = useViewPrefs();
  const by = session.user?.id;

  const [openEvent, setOpenEvent] = useState<string | null>(
    meet.events[0]?.id ?? null,
  );
  const [assigning, setAssigning] = useState<{ heat: Heat; lane: number } | null>(
    null,
  );

  const roster = useMemo(
    () => rosterForMeet(store.athletes, store.team, meet),
    [store.athletes, store.team, meet],
  );

  const event = meet.events.find((e) => e.id === openEvent) ?? meet.events[0];
  const heats = useMemo(
    () =>
      event
        ? meet.heats
            .filter((h) => h.eventId === event.id)
            .sort((a, b) => a.index - b.index)
        : [],
    [meet.heats, event],
  );

  if (meet.events.length === 0) {
    return (
      <EmptyState title="No events yet">
        Set the running order under Info before running the meet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <EventStrip
        meet={meet}
        openEvent={event?.id}
        onOpen={setOpenEvent}
      />

      {!event ? null : heats.length === 0 ? (
        <Card>
          <SectionTitle
            action={
              <Button
                size="sm"
                onClick={() => store.ensureHeats(meet.id, event.id)}
              >
                Seed heats
              </Button>
            }
          >
            {eventName(event)}
          </SectionTitle>
          <p className="text-sm text-slate-500">
            {(meet.entries[event.id] ?? []).length} entered, and no heats yet.
          </p>
        </Card>
      ) : (
        heats.map((heat) => (
          <HeatCard
            key={heat.id}
            meet={meet}
            event={event}
            heat={heat}
            nameOrder={nameOrder}
            by={by}
            onAssign={(lane) => setAssigning({ heat, lane })}
          />
        ))
      )}

      {assigning && (
        <LaneAssignSheet
          meet={meet}
          heat={assigning.heat}
          lane={assigning.lane}
          roster={roster}
          enrollments={enrollmentIndex(
            store.team,
            seasonForMeet(store.team, meet)?.id,
          )}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            store.assignToLane(
              meet.id,
              assigning.heat.id,
              assigning.lane,
              athleteId,
            );
            setAssigning(null);
          }}
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

/**
 * Every event, and how far along it is.
 *
 * Kept on screen rather than behind a dropdown: the question an administrator
 * asks most often is "what's left?", and a list answers it without a tap.
 */
function EventStrip({
  meet,
  openEvent,
  onOpen,
}: {
  meet: MeetDoc;
  openEvent: string | undefined;
  onOpen: (id: string) => void;
}) {
  const done = meet.events.filter((e) => eventClosed(meet, e.id)).length;

  return (
    <Card>
      <SectionTitle>
        Events — {done} of {meet.events.length} official
      </SectionTitle>
      <div className="flex flex-wrap gap-1.5">
        {meet.events.map((event, index) => {
          const official = eventClosed(meet, event.id);
          const open = event.id === openEvent;
          const entered = (meet.entries[event.id] ?? []).length;
          return (
            <button
              key={event.id}
              type="button"
              onClick={() => onOpen(event.id)}
              className={`rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
                open
                  ? "border-blue-600 bg-blue-600 text-white"
                  : official
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                    : "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              }`}
            >
              <span className="mr-1.5 tabular-nums opacity-60">{index + 1}</span>
              {eventName(event)}
              <span className="ml-1.5 text-xs opacity-70">
                {official ? "✓" : entered > 0 ? entered : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function HeatCard({
  meet,
  event,
  heat,
  nameOrder,
  by,
  onAssign,
}: {
  meet: MeetDoc;
  event: MeetEvent;
  heat: Heat;
  nameOrder: "first" | "last";
  by: string | undefined;
  onAssign: (lane: number) => void;
}) {
  const store = useAppStore();
  const progress = heatProgress(meet, heat);
  const closed = heatClosed(meet, heat);
  const active = activeLanes(meet, heat);

  return (
    <Card>
      <SectionTitle
        action={
          progress.accepted < progress.active ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => store.acceptHeat(meet.id, heat, by)}
            >
              Accept all ({progress.active - progress.accepted})
            </Button>
          ) : undefined
        }
      >
        {eventName(event)} · heat {heat.index + 1}
        {closed && (
          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            closed
          </span>
        )}
      </SectionTitle>

      {active.length === 0 && (
        <p className="mb-2 text-sm text-slate-500">
          Nothing recorded in this heat yet.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2 font-semibold">Lane</th>
              <th className="py-1 pr-2 font-semibold">Swimmer</th>
              <th className="py-1 pr-2 font-semibold">Watches</th>
              <th className="py-1 pr-2 font-semibold">Time</th>
              <th className="py-1 pr-2 font-semibold">Status</th>
              <th className="py-1 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {heat.lanes.map((_, index) => (
              <LaneRow
                key={index}
                meet={meet}
                heat={heat}
                lane={index + 1}
                nameOrder={nameOrder}
                by={by}
                onAssign={onAssign}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUSES: ResultStatus[] = ["OK", "DQ", "NS"];

function LaneRow({
  meet,
  heat,
  lane,
  nameOrder,
  by,
  onAssign,
}: {
  meet: MeetDoc;
  heat: Heat;
  lane: number;
  nameOrder: "first" | "last";
  by: string | undefined;
  onAssign: (lane: number) => void;
}) {
  const store = useAppStore();
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");

  const watches = watchesForLane(meet, heat.id, lane);
  const accepted = acceptedForLane(meet, heat.id, lane);
  const proposed = resultForLane(meet, heat, lane);
  const derived = officialTime(watches);
  const ruling = rulingForLane(meet, heat.id, lane);

  const seated = heat.lanes[lane - 1];
  const claimed = attributedAthlete(watches);
  const athleteId = accepted?.athleteId ?? seated ?? claimed ?? null;
  const athlete = findAthlete(store.athletes, athleteId);

  // An empty lane nobody has touched is just an empty lane.
  const idle = !seated && !claimed && watches.length === 0 && !ruling && !accepted;

  const save = (override?: { timeMs?: number; status?: ResultStatus }) => {
    store.acceptLane(meet.id, heat, lane, by, override);
    setEditing(false);
    setTyped("");
  };

  return (
    <tr
      className={`border-t border-slate-100 dark:border-slate-800 ${
        accepted ? "bg-emerald-50/60 dark:bg-emerald-950/30" : ""
      }`}
    >
      <td className="py-2 pr-2 font-bold tabular-nums">{lane}</td>

      <td className="py-2 pr-2">
        <button
          type="button"
          onClick={() => onAssign(lane)}
          className="text-left"
        >
          <span className="block font-medium">
            {athlete ? displayName(athlete, nameOrder) : "— assign —"}
          </span>
          {!seated && claimed && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              per timer
            </span>
          )}
        </button>
      </td>

      {/* What each timer actually sent. The point of showing them all is that
          a single outlier is obvious at a glance. */}
      <td className="py-2 pr-2 font-mono text-xs tabular-nums text-slate-500">
        {watches.length === 0
          ? "—"
          : watches.map((w) => formatTime(w.timeMs)).join("  ")}
      </td>

      <td className="py-2 pr-2 font-mono tabular-nums">
        {editing ? (
          <TextInput
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            inputMode="numeric"
            placeholder={derived ? formatTime(derived.timeMs) : "0000"}
            autoFocus
          />
        ) : accepted ? (
          <span className="font-semibold">{formatTime(accepted.timeMs)}</span>
        ) : proposed ? (
          <span className="text-slate-600 dark:text-slate-300">
            {formatTime(proposed.timeMs)}
            {derived && (
              <span className="ml-1 text-xs text-slate-400">
                {derived.method === "single" ? "1 watch" : derived.method}
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>

      <td className="py-2 pr-2">
        <div className="flex gap-1">
          {STATUSES.map((status) => {
            const current = accepted?.status ?? proposed?.status ?? "OK";
            return (
              <button
                key={status}
                type="button"
                disabled={idle}
                onClick={() => save({ status })}
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  current === status
                    ? status === "OK"
                      ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
                      : "bg-red-600 text-white"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                } ${idle ? "opacity-40" : ""}`}
              >
                {status}
              </button>
            );
          })}
        </div>
      </td>

      <td className="py-2 text-right">
        {editing ? (
          <span className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const ms = parseTime(typed);
                save(ms !== null ? { timeMs: ms } : undefined);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        ) : accepted ? (
          <span className="flex items-center justify-end gap-2">
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              accepted
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => store.unacceptLane(meet.id, heat, lane)}
            >
              Undo
            </Button>
          </span>
        ) : (
          <span className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={idle}
              onClick={() => {
                setTyped("");
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="success"
              disabled={idle || !proposed}
              onClick={() => save()}
            >
              Accept
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

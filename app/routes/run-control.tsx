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
import { entrySplit } from "~/lib/events";
import { useAppStore } from "~/state/app-store";
import { useSession } from "~/state/session";
import { useViewPrefs } from "~/state/view-prefs";
import {
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

  // Who this device can actually resolve. An entry naming somebody outside
  // this set is an orphan — see `entrySplit`.
  const known = useMemo(
    () => new Set(store.athletes.map((a) => a.id)),
    [store.athletes],
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
    <>
      {/* Two panels side by side once there's room: the running order stays
          put on the left while the heat you're working fills the rest. On a
          phone they stack, because a rail and a table can't share 390px. */}
      <div className="lg:grid lg:grid-cols-[minmax(15rem,28%)_minmax(0,1fr)] lg:gap-4">
        <EventRail
          meet={meet}
          known={known}
          openEvent={event?.id}
          onOpen={setOpenEvent}
        />

        <div className="mt-4 min-w-0 space-y-4 lg:mt-0">
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
                {entrySplit(meet, event.id, known).entered} entered, and no
                heats yet.
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
        </div>
      </div>

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
    </>
  );
}

/**
 * The running order, down the side.
 *
 * A list rather than a wrapping block of buttons. Twenty-four events laid out
 * as chips reflow into a wall of different-width targets that's genuinely hard
 * to read down — and reading down is the whole job, because the question an
 * administrator asks over and over is "what's left?".
 */
function EventRail({
  meet,
  known,
  openEvent,
  onOpen,
}: {
  meet: MeetDoc;
  known: Set<string>;
  openEvent: string | undefined;
  onOpen: (id: string) => void;
}) {
  const done = meet.events.filter((e) => eventClosed(meet, e.id)).length;

  return (
    <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-var(--app-chrome-top)-var(--app-chrome-bottom)-2rem)] lg:overflow-y-auto">
      <SectionTitle>
        {done} of {meet.events.length} official
      </SectionTitle>

      <ol className="-mx-2">
        {meet.events.map((event, index) => {
          const official = eventClosed(meet, event.id);
          const open = event.id === openEvent;
          const { entered, orphaned } = entrySplit(meet, event.id, known);
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event.id)}
                aria-current={open ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                  open
                    ? "bg-blue-600 text-white"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <span
                  className={`w-5 shrink-0 text-right tabular-nums ${
                    open ? "text-white/70" : "text-slate-400"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {eventName(event)}
                </span>
                {orphaned > 0 && (
                  <span
                    className={`shrink-0 text-xs ${open ? "text-amber-200" : "text-amber-600 dark:text-amber-400"}`}
                    title={`${orphaned} ${orphaned === 1 ? "entry" : "entries"} point at swimmers who aren't on the roster — most likely from a re-import. They don't appear on the entries grid.`}
                  >
                    !{orphaned}
                  </span>
                )}
                <span
                  className={`shrink-0 text-xs tabular-nums ${
                    open
                      ? "text-white/80"
                      : official
                        ? "font-semibold text-emerald-600 dark:text-emerald-400"
                        : "text-slate-500"
                  }`}
                >
                  {official ? "✓" : entered > 0 ? entered : "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
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

  /**
   * Record the call, then sign the lane off.
   *
   * Two writes, one tap. The typed time and the status are judgements about
   * what happened — claims alongside the watches — and the acceptance is the
   * separate act of saying the lane is final. Keeping them apart is what makes
   * "Undo" return to the official's own reading rather than back to the raw
   * watches, and what lets the record say who entered a time and when.
   */
  const save = (call?: { timeMs?: number; status?: ResultStatus }) => {
    if (call?.timeMs !== undefined) {
      store.overrideLaneTime(meet.id, heat, lane, call.timeMs, by);
    }
    if (call?.status !== undefined) {
      store.setLaneStatus(meet.id, heat, lane, call.status, by);
    }
    store.acceptLane(meet.id, heat, lane, by);
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
          {/* A timer naming somebody other than whoever is seated normally
              moves them, so this only shows while the two disagree — an
              offline phone that hasn't sent yet, or two timers on one lane
              each naming a different swimmer. Worth seeing rather than
              resolving silently. */}
          {seated && claimed && claimed !== seated && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              a timer says{" "}
              {findAthlete(store.athletes, claimed)
                ? displayName(findAthlete(store.athletes, claimed)!, nameOrder)
                : "somebody else"}
            </span>
          )}
        </button>
      </td>

      {/* Every timer's own send, one chip each. Shown in full rather than
          summarised because a single slow thumb is obvious side by side and
          invisible once averaged — and because the median only means anything
          if you can see what it chose between. */}
      <td className="py-2 pr-2">
        <span className="flex flex-wrap items-center gap-1">
          {watches.length === 0 && (
            <span className="text-xs text-slate-400">—</span>
          )}
          {watches.map((w) => (
            <span
              key={w.id}
              title={`${w.timerId}${w.source === "typed" ? " (typed)" : ""}`}
              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {formatTime(w.timeMs)}
            </span>
          ))}
          {ruling?.timeMs !== undefined && (
            <span
              title={`Entered by hand${ruling.decidedBy ? "" : ""} — stands over the watches`}
              className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {formatTime(ruling.timeMs)} ✎
            </span>
          )}
        </span>
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
              title="Takes the sign-off back. Any time you entered by hand stays."
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
              {ruling?.timeMs !== undefined ? "Re-enter" : "Edit"}
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

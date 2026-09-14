import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Button, Card, EmptyState, SectionTitle, TextInput } from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import {
  activeLanes,
  athleteInLane,
  callForLane,
  eventClosed,
  heatClosed,
  heatProgress,
  proposedTime,
  resultForLane,
  watchesForLane,
} from "~/lib/timing";
import { applyPending } from "~/lib/pending";
import { usePending, useSend } from "~/state/outbox";
import type { Write } from "~/lib/outbox";
import { useMeet } from "./meet-layout";
import { useViewPrefs } from "~/state/view-prefs";
import {
  displayName,
  eventName,
  findAthlete,
  type Heat,
  type MeetDetail,
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
export function RunControl() {
  const { detail: loaded, access } = useMeet();
  const pending = usePending();
  const send = useSend();
  const detail = useMemo(() => applyPending(loaded, pending), [loaded, pending]);
  const meet = detail.meet;
  const { nameOrder } = useViewPrefs();
  const seed = useFetcher();

  const [openEvent, setOpenEvent] = useState<string | null>(
    detail.events[0]?.id ?? null,
  );
  const [assigning, setAssigning] = useState<{ heat: Heat; lane: number } | null>(
    null,
  );

  const roster = detail.athletes;

  const event = detail.events.find((e) => e.id === openEvent) ?? detail.events[0];
  const heats = useMemo(
    () =>
      event
        ? detail.heats
            .filter((h) => h.eventId === event.id)
            .sort((a, b) => a.index - b.index)
        : [],
    [detail.heats, event],
  );

  if (detail.events.length === 0) {
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
        <EventRail detail={detail} openEvent={event?.id} onOpen={setOpenEvent} />

        <div className="mt-4 min-w-0 space-y-4 lg:mt-0">
          {!event ? null : heats.length === 0 ? (
            <Card>
              <SectionTitle
                action={
                  <Button
                    size="sm"
                    onClick={() =>
                      seed.submit(
                        { eventId: event.id },
                        {
                          method: "post",
                          action: `/meets/${meet.id}/run`,
                          encType: "application/json",
                        },
                      )
                    }
                  >
                    Seed heats
                  </Button>
                }
              >
                {eventName(event)}
              </SectionTitle>
              <p className="text-sm text-slate-500">
                {(detail.entries[event.id] ?? []).length} entered, and no heats
                yet.
              </p>
            </Card>
          ) : (
            heats.map((heat) => (
              <HeatCard
                key={heat.id}
                detail={detail}
                event={event}
                heat={heat}
                nameOrder={nameOrder}
                send={send}
                onAssign={(lane) => setAssigning({ heat, lane })}
              />
            ))
          )}
        </div>
      </div>

      {assigning && (
        <LaneAssignSheet
          detail={detail}
          heat={assigning.heat}
          lane={assigning.lane}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            send({
              kind: "seat",
              meetId: meet.id,
              heatId: assigning.heat.id,
              lane: assigning.lane,
              athleteId,
            });
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
  detail,
  openEvent,
  onOpen,
}: {
  detail: MeetDetail;
  openEvent: string | undefined;
  onOpen: (id: string) => void;
}) {
  const done = detail.events.filter((e) => eventClosed(detail, e.id)).length;

  return (
    <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-var(--app-chrome-top)-var(--app-chrome-bottom)-2rem)] lg:overflow-y-auto">
      <SectionTitle>
        {done} of {detail.events.length} official
      </SectionTitle>

      <ol className="-mx-2">
        {detail.events.map((event, index) => {
          const official = eventClosed(detail, event.id);
          const open = event.id === openEvent;
          const entered = (detail.entries[event.id] ?? []).length;
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
  detail,
  event,
  heat,
  nameOrder,
  send,
  onAssign,
}: {
  detail: MeetDetail;
  event: MeetEvent;
  heat: Heat;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  onAssign: (lane: number) => void;
}) {
  const progress = heatProgress(detail, heat);
  const closed = heatClosed(detail, heat);
  const active = activeLanes(detail, heat);
  const outstanding = active.filter(
    (lane) => callForLane(detail, heat.id, lane)?.final !== true,
  );

  return (
    <Card>
      <SectionTitle
        action={
          progress.signedOff < progress.active ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                // Only the lanes still outstanding, so "sign off all" never
                // quietly overwrites a correction somebody already made.
                for (const lane of outstanding) {
                  send({
                    kind: "call",
                    meetId: detail.meet.id,
                    heatId: heat.id,
                    lane,
                    final: true,
                  });
                }
              }}
            >
              Sign off ({outstanding.length})
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
                detail={detail}
                heat={heat}
                lane={index + 1}
                nameOrder={nameOrder}
                send={send}
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
  detail,
  heat,
  lane,
  nameOrder,
  send,
  onAssign,
}: {
  detail: MeetDetail;
  heat: Heat;
  lane: number;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  onAssign: (lane: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");

  const watches = watchesForLane(detail, heat.id, lane);
  const call = callForLane(detail, heat.id, lane);
  const proposed = resultForLane(detail, heat, lane);
  const derived = proposedTime(watches);

  const seated = heat.lanes[lane - 1];
  const athleteId = athleteInLane(detail, heat, lane);
  const athlete = findAthlete(detail.athletes, athleteId);
  const signedOff = call?.final === true;

  // An empty lane nobody has touched is just an empty lane. A lane with a time
  // and nobody in it is the opposite — it's the thing most needing a decision.
  const idle = !seated && watches.length === 0 && !call;
  const orphanTime = !athleteId && watches.length > 0;

  /**
   * Record the decision.
   *
   * One write, whatever changed. The status, the official's own time and the
   * sign-off are three fields of one call, folded onto whatever is already
   * there — so marking a DQ keeps a typed time and typing a time keeps a DQ.
   * Taking a sign-off back flips `final` and leaves the reading, which is what
   * makes "Undo" land on the official's own number rather than the raw
   * watches.
   */
  const save = (patch: {
    timeMs?: number;
    status?: ResultStatus;
    final?: boolean;
  }) => {
    send({
      kind: "call",
      meetId: detail.meet.id,
      heatId: heat.id,
      lane,
      ...patch,
    });
    setEditing(false);
    setTyped("");
  };

  return (
    <tr
      className={`border-t border-slate-100 dark:border-slate-800 ${
        signedOff ? "bg-emerald-50/60 dark:bg-emerald-950/30" : ""
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
          {orphanTime && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              a time with nobody in the lane
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
              key={w.timerId}
              title={`${w.timerId}${w.source === "typed" ? " (typed)" : ""}`}
              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {formatTime(w.timeMs)}
            </span>
          ))}
          {call?.timeMs !== undefined && (
            <span
              title="Entered by hand — stands over the watches"
              className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {formatTime(call.timeMs)} ✎
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
        ) : signedOff && proposed ? (
          <span className="font-semibold">{formatTime(proposed.timeMs)}</span>
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
            const current = call?.status ?? proposed?.status ?? "OK";
            return (
              <button
                key={status}
                type="button"
                disabled={idle}
                onClick={() => save({ status, final: true })}
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
                save(ms !== null ? { timeMs: ms, final: true } : { final: true });
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        ) : signedOff ? (
          <span className="flex items-center justify-end gap-2">
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              signed off
            </span>
            <Button
              size="sm"
              variant="ghost"
              title="Takes the sign-off back. Any time you entered by hand stays."
              onClick={() => save({ final: false })}
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
              {call?.timeMs !== undefined ? "Re-enter" : "Edit"}
            </Button>
            <Button
              size="sm"
              variant="success"
              disabled={idle || !proposed}
              onClick={() => save({ final: true })}
            >
              Sign off
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

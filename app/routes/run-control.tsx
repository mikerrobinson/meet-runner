import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Button, Card, EmptyState, SectionTitle, TextInput } from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import {
  activeLanes,
  fromStopwatch,
  athleteInLane,
  callForLane,
  eventClosed,
  heatClosed,
  heatProgress,
  laneProgress,
  laneTime,
  resultForLane,
  watchesForLane,
} from "~/lib/timing";
import { applyPending } from "~/lib/pending";
import { usePending, useSend } from "~/state/outbox";
import type { Write } from "~/lib/outbox";
import type { LaneProgress, LaneTime } from "~/lib/timing";
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
  type TimerActivity,
  type WatchRole,
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

  // Only while a thumb is actually down somewhere in the meet.
  const now = useTicker(
    detail.activity.some((a) => a.startedAt !== undefined && a.stoppedAt === undefined),
  );

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
                me={access.userId}
                now={now}
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
  me,
  now,
  onAssign,
}: {
  detail: MeetDetail;
  event: MeetEvent;
  heat: Heat;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  /** Whoever is at the desk — the watch they type is filed under them. */
  me: string | null;
  /** A one-second beat, for drawing stopwatches that are still running. */
  now: number;
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
                me={me}
                now={now}
                onAssign={onAssign}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Re-render on a one-second beat, and only while a stopwatch is actually
 * running somewhere in this meet.
 *
 * One interval for the whole screen rather than one per lane, and none at all
 * for the ninety per cent of a meet when nothing is in the water — a desk
 * tablet shouldn't re-render a twenty-four event programme every second to
 * animate nothing.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Stopwatches that are running: started, not stopped, nothing sent yet. */
function runningOn(
  detail: MeetDetail,
  heatId: string,
  lane: number,
): TimerActivity[] {
  return detail.activity.filter(
    (a) =>
      a.heatId === heatId &&
      a.lane === lane &&
      a.startedAt !== undefined &&
      a.stoppedAt === undefined &&
      // Once a time has arrived the clock is history; the chip becomes the
      // number. A watch still running *and* already submitted is a timer who
      // re-armed, and the submitted time is the one that counts.
      !detail.watches.some(
        (w) => w.heatId === heatId && w.lane === lane && w.timerId === a.timerId,
      ),
  );
}

const STATUSES: ResultStatus[] = ["OK", "DQ", "NS"];

/**
 * Where a lane's time came from, in the fewest words that still answer it.
 *
 * The desk's job is deciding what stands, and it cannot do that from a number
 * alone: three timers' median and one coach's stopwatch look identical until
 * something says which it is.
 */
/**
 * How the time box reads at a glance, before anybody reads the number.
 *
 * The distinction that earns its keep is the middle one. A lane with nothing
 * on it and a lane whose timers are all still holding their clocks show the
 * same empty box, and they want opposite responses — send somebody to cover
 * it, or leave it alone. Amber is "this is in hand"; grey is "nobody is on
 * this lane".
 */
const TIME_TONE: Record<LaneProgress, string> = {
  none: "border-dashed border-slate-300 bg-transparent text-slate-400 dark:border-slate-700",
  waiting:
    "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  complete:
    "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100",
};

const PROGRESS_HINT: Record<LaneProgress, string> = {
  none: "No stopwatch on this lane yet",
  waiting: "Timing in progress — not every watch is in",
  complete: "Every watch on this lane is in",
};

const ROLE_LABEL: Record<WatchRole, string> = {
  timer: "Timer",
  coach: "A coach",
  admin: "Entered at the desk",
};

function describeTime(time: LaneTime): string {
  if (time.from === "admin") return "yours";
  if (time.from === "coach") {
    return time.watchCount === 1 ? "1 coach" : `${time.watchCount} coaches`;
  }
  return time.method === "single" ? "1 watch" : time.method;
}

function LaneRow({
  detail,
  heat,
  lane,
  nameOrder,
  send,
  me,
  now,
  onAssign,
}: {
  detail: MeetDetail;
  heat: Heat;
  lane: number;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  me: string | null;
  now: number;
  onAssign: (lane: number) => void;
}) {
  /**
   * What's in the box while somebody is typing in it.
   *
   * `null` means nobody is, and the box shows the lane's time. It has to be
   * this way round because the screen re-reads the meet every few seconds: a
   * plain controlled value would be overwritten mid-keystroke by a poll, and
   * a plain uncontrolled one would never show a time arriving from a phone.
   */
  const [draft, setDraft] = useState<string | null>(null);

  const watches = watchesForLane(detail, heat.id, lane);
  const call = callForLane(detail, heat.id, lane);
  const proposed = resultForLane(detail, heat, lane);
  const derived = laneTime(watches);

  const seated = heat.lanes[lane - 1];
  const athleteId = athleteInLane(detail, heat, lane);
  const athlete = findAthlete(detail.athletes, athleteId);
  const signedOff = call?.final === true;

  // An empty lane nobody has touched is just an empty lane. A lane with a time
  // and nobody in it is the opposite — it's the thing most needing a decision.
  const idle = !seated && watches.length === 0 && !call;
  const orphanTime = !athleteId && watches.length > 0;

  /**
   * Type a time in at the desk.
   *
   * It is a **watch**, not a ruling — one more reading of the same race,
   * filed under whoever typed it exactly as a phone's is filed under the
   * phone. A time is a time however it reached the meet: off a multi-lane
   * stopwatch, off a handheld read out down the pool, or off the board.
   *
   * It used to be written onto the call, where it outranked every watch on
   * the lane. That made the desk's number a silent override with nothing to
   * show what it overrode — and it meant the same act of reading a clock was
   * stored two different ways depending on who did it. Discarding a watch the
   * desk doesn't believe is the honest version of the same power, and it
   * leaves the reason visible in what's left.
   */
  const typeTime = (timeMs: number) => {
    send({
      kind: "watch",
      meetId: detail.meet.id,
      heatId: heat.id,
      lane,
      // The server files it under the signed-in user regardless; this is what
      // the optimistic overlay needs to agree with it about.
      timerId: me ?? "desk",
      userId: me ?? undefined,
      // Only an administrator reaches this screen, and the server checks it
      // again — this is what the overlay needs to rank the row correctly
      // before the server answers.
      role: "admin",
      timeMs,
      recordedAt: Date.now(),
    });
  };

  /**
   * Record the decision.
   *
   * The status and the sign-off are two fields of one call, folded onto
   * whatever is already there — so marking a DQ keeps the sign-off and
   * signing off keeps the DQ.
   */
  const progress = laneProgress(detail, heat.id, lane);
  const running = runningOn(detail, heat.id, lane);

  /**
   * What the box shows: what somebody is typing, or the lane's time.
   *
   * `resultForLane` rather than `laneTime` directly, because it is the one
   * every other screen reads and the box must not disagree with the results
   * page about what this lane swam. It adds two things on top: a signed-off
   * lane reads the number that was accepted rather than what the watches say
   * now, and a lane carrying a time written onto the call by an older build
   * still reads that.
   *
   * Falling back to `laneTime` covers the lane with a time and nobody in it —
   * no result to speak of, but a number the desk needs to see while it works
   * out whose it was.
   */
  const accepted = proposed ?? derived;
  const shownTime =
    draft ?? (accepted ? formatTime(accepted.timeMs) : "");

  /**
   * Take what was typed, if it changed anything.
   *
   * Unchanged is the common case — the desk tabs through a heat reading times
   * without meaning to alter one — so an unchanged box must write nothing at
   * all, or every glance would file a ruling. Emptying it withdraws the
   * desk's own reading and lets the lane fall back to the watches, which is
   * the way out of a number typed by mistake.
   */
  const commitTime = () => {
    const text = draft;
    setDraft(null);
    if (text === null) return;

    const mine = watches.find((w) => w.role === "admin" && w.timerId === me);
    if (text.trim() === "") {
      if (mine) {
        send({
          kind: "drop-watch",
          meetId: detail.meet.id,
          heatId: heat.id,
          lane,
          timerId: mine.timerId,
        });
      }
      return;
    }

    const ms = parseTime(text);
    if (ms === null || ms === accepted?.timeMs) return;
    typeTime(ms);
  };

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
          {watches.length === 0 && running.length === 0 && (
            <span className="text-xs text-slate-400">—</span>
          )}

          {/* A stopwatch that is still going.
              
              The desk can see the race it is watching, so the number itself is
              not the point — what it answers is which lanes are actually being
              timed, and, once a heat is long over, which timer is still
              holding a clock they forgot to stop. That one is invisible
              otherwise: the lane simply never completes and nobody knows why.
              
              Counted from the server's clock, which is why the phone's start
              was translated onto it on the way in. */}
          {running.map((a) => (
            <span
              key={`running-${a.timerId}`}
              title={`Timer ${a.timerId} is still timing this lane`}
              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              <span aria-hidden className="text-[0.6rem]">▶</span>
              {formatClock(Math.max(0, now - a.startedAt!))}
            </span>
          ))}
          {/* Each watch with a way to drop it.
              
              This is the desk's real power over a time, and it replaced a
              number typed onto the call that silently outranked everything.
              Throwing out the reading you don't believe says which one you
              didn't believe; overriding it said nothing at all. */}
          {watches.map((w) => {
            // Which watches actually made the number. Everything is kept and
            // everything is shown — a coach's stopwatch is still evidence —
            // but a chip that fed the time has to look different from one
            // that was outranked, or the desk is reading five numbers and
            // guessing which three it is being asked to accept.
            const counted = derived !== null && w.role === derived.from;
            return (
            <span
              key={w.timerId}
              title={
                `${ROLE_LABEL[w.role]}${w.userId ? "" : ` ${w.timerId}`}` +
                (fromStopwatch(w) ? " · off a stopwatch" : " · typed in") +
                (counted ? "" : " · not counted, outranked")
              }
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums ${
                !counted
                  ? "bg-slate-100 text-slate-400 line-through dark:bg-slate-900 dark:text-slate-600"
                  : w.role === "admin"
                    ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {formatTime(w.timeMs)}
              {!fromStopwatch(w) && "✎"}
              <button
                type="button"
                aria-label={`Discard the ${formatTime(w.timeMs)} watch`}
                title="Discard this watch"
                onClick={() =>
                  send({
                    kind: "drop-watch",
                    meetId: detail.meet.id,
                    heatId: heat.id,
                    lane,
                    timerId: w.timerId,
                  })
                }
                className="text-red-600 hover:text-red-500"
              >
                ✕
              </button>
            </span>
            );
          })}
          {/* A number written onto the call by an older build. Nothing writes
              these any more; it still outranks the watches, so it says so. */}
          {call?.timeMs !== undefined && (
            <span
              title="Entered by hand on an older build — stands over the watches"
              className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {formatTime(call.timeMs)} ✎
            </span>
          )}
        </span>
      </td>

      {/* Always a box, never a label that turns into one.
          
          The desk's job on every row is the same — read the time, change it if
          it's wrong — and an Edit button made the second of those a different
          mode to enter. A box that already holds the number is one tap
          shorter and reads the same whether or not you're about to touch it.
          
          Its colour is the lane's timing, which the number alone can't say:
          blank-and-grey is nobody covering this lane, amber is watches running
          or some in, green is the timing table done. */}
      <td className="py-2 pr-2">
        <TextInput
          value={shownTime}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commitTime}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTime();
            if (event.key === "Escape") setDraft(null);
          }}
          inputMode="numeric"
          placeholder={progress === "none" ? "" : "0000"}
          aria-label={`Time for lane ${lane}`}
          title={PROGRESS_HINT[progress]}
          tone={TIME_TONE[progress]}
          className="!w-28 text-center font-mono tabular-nums"
        />
        {derived && (
          <span className="ml-1 text-xs text-slate-400">
            {describeTime(derived)}
          </span>
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
        {signedOff ? (
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
          <Button
            size="sm"
            variant="success"
            disabled={idle || !proposed}
            onClick={() => save({ final: true })}
          >
            Sign off
          </Button>
        )}
      </td>
    </tr>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Button, Card, EmptyState, SectionTitle, TextInput } from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { generateId } from "~/lib/id";
import {
  eventClosed,
  fromStopwatch,
  heatClosed,
  heatProgress,
  heatsOf,
  laneProgress,
  laneTime,
  resultFor,
  runningWatches,
  seedsForHeat,
  swimTime,
  watchesOn,
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
  type MeetDetail,
  type MeetEvent,
  type Seed,
  type ResultStatus,
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
    detail.watches.some(
      (w) => w.timeMs === undefined && w.startedAt !== undefined,
    ),
  );

  const [openEvent, setOpenEvent] = useState<string | null>(
    detail.events[0]?.id ?? null,
  );
  const [assigning, setAssigning] = useState<{ heat: number; lane: number } | null>(
    null,
  );

  const roster = detail.athletes;

  const event = detail.events.find((e) => e.id === openEvent) ?? detail.events[0];
  // A heat is the distinct heats across an event's seeds, so one with nothing
  // in it cannot arise — and "no heats yet" means "nothing seeded yet".
  const heats = useMemo(
    () => (event ? heatsOf(detail, event.id) : []),
    [detail, event],
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
                key={heat}
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
          eventId={event?.id ?? ""}
          heat={assigning.heat}
          lane={assigning.lane}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            if (!event) return;
            send({
              kind: "seed",
              meetId: meet.id,
              eventId: event.id,
              heat: assigning.heat,
              lane: assigning.lane,
              athleteId,
              // The id the server will use if this lane is new. When it isn't,
              // the server keeps the row that's there and this is ignored —
              // the overlay agrees either way.
              seedId: generateId(),
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
  heat: number;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  /** Whoever is at the desk — the watch they type is filed under them. */
  me: string | null;
  /** A one-second beat, for drawing stopwatches that are still running. */
  now: number;
  onAssign: (lane: number) => void;
}) {
  const seeds = seedsForHeat(detail, event.id, heat);
  const progress = heatProgress(detail, event.id, heat);
  const closed = heatClosed(detail, event.id, heat);

  // Only the swims still outstanding, so "sign off all" never quietly
  // overwrites a correction somebody already made.
  const outstanding = seeds.filter(
    (seed) => resultFor(detail, seed.id) === undefined,
  );

  return (
    <Card>
      <SectionTitle
        action={
          outstanding.length > 0 ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                for (const seed of outstanding) {
                  const time = laneTime(watchesOn(detail, seed.id));
                  // Nothing to accept on a lane with no time at all: signing
                  // one off would record a zero as though somebody swam it.
                  if (!time) continue;
                  send({
                    kind: "result",
                    meetId: detail.meet.id,
                    seedId: seed.id,
                    status: "OK",
                    timeMs: time.timeMs,
                  });
                }
              }}
            >
              Sign off ({outstanding.length})
            </Button>
          ) : undefined
        }
      >
        {eventName(event)} · heat {heat}
        {closed && (
          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            closed
          </span>
        )}
      </SectionTitle>

      {seeds.length === 0 && (
        <p className="mb-2 text-sm text-slate-500">
          Nobody is in this heat yet.
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
            {/* Every lane of the pool, not only the seeded ones: an empty
                lane is where somebody gets added, and a lane the desk can't
                see is a lane it can't fill. */}
            {Array.from({ length: detail.meet.laneCount }, (_, i) => i + 1).map(
              (lane) => (
              <LaneRow
                key={lane}
                detail={detail}
                event={event}
                heat={heat}
                lane={lane}
                nameOrder={nameOrder}
                send={send}
                me={me}
                now={now}
                onAssign={onAssign}
              />
              ),
            )}
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
  event,
  heat,
  lane,
  nameOrder,
  send,
  me,
  now,
  onAssign,
}: {
  detail: MeetDetail;
  event: MeetEvent;
  heat: number;
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

  /** The swim in this lane, if anybody has said who is in it. */
  const seed = detail.seeds.find(
    (s) => s.eventId === event.id && s.heat === heat && s.lane === lane,
  );
  const watches = seed ? watchesOn(detail, seed.id) : [];
  const timed = watches.filter((w) => w.timeMs !== undefined);
  const running = seed ? runningWatches(detail, seed.id) : [];
  const result = seed ? resultFor(detail, seed.id) : undefined;
  const accepted = seed ? swimTime(detail, seed.id) : null;
  const derived = laneTime(watches);
  const progress = seed ? laneProgress(detail, seed.id) : "none";

  const athlete = findAthlete(detail.athletes, seed?.athleteId ?? null);
  const signedOff = result !== undefined;

  // A lane with nobody in it and nothing against it is just an empty lane.
  const idle = !seed;

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
    if (!seed) return;
    send({
      kind: "watch",
      meetId: detail.meet.id,
      seedId: seed.id,
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
   * What the box shows: what somebody is typing, or the swim's time.
   *
   * `swimTime` rather than `laneTime` directly, because it is the one every
   * other screen reads and the box must not disagree with the results page
   * about what this lane swam. It adds the thing that matters: a signed-off
   * swim reads the number that was accepted rather than what the watches say
   * now, so a late watch cannot move it.
   */
  const shownTime = draft ?? (accepted ? formatTime(accepted.timeMs) : "");

  /**
   * Take what was typed, if it changed anything.
   *
   * Unchanged is the common case — the desk tabs through a heat reading times
   * without meaning to alter one — so an unchanged box must write nothing at
   * all, or every glance would file a ruling. Emptying it withdraws the
   * desk's own reading and lets the swim fall back to the watches, which is
   * the way out of a number typed by mistake.
   */
  const commitTime = () => {
    const text = draft;
    setDraft(null);
    if (text === null || !seed) return;

    const mine = watches.find((w) => w.role === "admin" && w.timerId === me);
    if (text.trim() === "") {
      if (mine) {
        send({
          kind: "drop-watch",
          meetId: detail.meet.id,
          seedId: seed.id,
          timerId: mine.timerId,
        });
      }
      return;
    }

    const ms = parseTime(text);
    if (ms === null || ms === accepted?.timeMs) return;
    typeTime(ms);
  };

  /**
   * Sign the swim off, as whatever it was.
   *
   * One act rather than two: the status is chosen *as* the lane is accepted,
   * and the number written down is the one that was on screen — so a watch
   * landing in the same second cannot sign off a time nobody looked at.
   * Taking it back is deleting the row, which is what `unresult` does.
   */
  const signOff = (status: ResultStatus) => {
    if (!seed) return;
    send({
      kind: "result",
      meetId: detail.meet.id,
      seedId: seed.id,
      status,
      // A no-show or a disqualification needn't have a time behind it.
      timeMs: status === "OK" ? (accepted?.timeMs ?? 0) : (accepted?.timeMs ?? 0),
    });
  };

  const undo = () => {
    if (!seed) return;
    send({ kind: "unresult", meetId: detail.meet.id, seedId: seed.id });
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
          {!seed && running.length > 0 && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              a stopwatch running on an empty lane
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
          {timed.length === 0 && running.length === 0 && (
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
          {timed.map((w) => {
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
              {formatTime(w.timeMs!)}
              {!fromStopwatch(w) && "✎"}
              <button
                type="button"
                aria-label={`Discard the ${formatTime(w.timeMs!)} watch`}
                title="Discard this watch"
                onClick={() =>
                  seed &&
                  send({
                    kind: "drop-watch",
                    meetId: detail.meet.id,
                    seedId: seed.id,
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

      {/* Status is how the lane is signed off, not a separate mark made
          beforehand. Tapping one accepts the swim as that — which is the act
          the desk came to the row to perform, in one tap rather than two. */}
      <td className="py-2 pr-2">
        <div className="flex gap-1">
          {STATUSES.map((status) => {
            const current = result?.status ?? "OK";
            const chosen = signedOff && current === status;
            return (
              <button
                key={status}
                type="button"
                disabled={idle}
                title={
                  signedOff
                    ? `Signed off as ${status}`
                    : `Sign this lane off as ${status}`
                }
                onClick={() => signOff(status)}
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  chosen
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
              title="Takes the sign-off back. Every watch underneath it stays."
              onClick={undo}
            >
              Undo
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="success"
            disabled={idle || !accepted}
            onClick={() => signOff("OK")}
          >
            Sign off
          </Button>
        )}
      </td>
    </tr>
  );
}

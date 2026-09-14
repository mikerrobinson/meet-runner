import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Route } from "./+types/run";
import type { Progress } from "~/types/meet";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { LaneTile } from "~/components/LaneTile";
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Segmented,
  Sheet,
  TextInput,
} from "~/components/ui";
import { useElapsed, useWakeLock } from "~/hooks/use-stopwatch";
import { heatsForEvent, reseedHeats, shuffle } from "~/lib/heats";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { mayEditMeet } from "~/lib/access";
import { meetAccess } from "~/lib/access.server";
import { meetDetail, replaceHeats } from "~/lib/meets.server";
import { heatTouched, resultsForHeat, watchesForLane } from "~/lib/timing";
import { loadProgress, saveProgress } from "~/lib/storage";

import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { mayDecide } from "~/lib/access";
import { applyPending } from "~/lib/pending";
import { useFetcher } from "react-router";
import { usePending, useSend } from "~/state/outbox";
import { useMeet } from "./meet-layout";
import { RunControl } from "./run-control";
import { useViewPrefs } from "~/state/view-prefs";
import {
  byAthlete,
  displayName,
  eventName,
  findAthlete,
  isDiving,
  orderedLanes,
  type Heat,
  type MeetDetail,
  type MeetEvent,
  type NameOrder,
  type Result,
  type Athlete,
  type Watch,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Run Meet · Meet Runner" }];
}

/** How an official time was arrived at, for the lane sheet. */
const METHOD_LABEL: Record<string, string> = {
  single: "one watch",
  average: "average of 2",
  median: "middle of 3",
  official: "set by hand",
};

/**
 * Running a meet, from whichever seat you're in.
 *
 * Three people are working the same water at once and they need different
 * screens: an administrator signing off times at a table, a coach with a
 * multi-lane stopwatch on the deck, and a timer with one lane and one button
 * (that one lives at `/timer`, behind a QR code, with no account at all).
 *
 * The default follows the role, because the common case is that you want the
 * screen your job needs. An administrator can still switch — they often hold a
 * watch too — but a coach is never shown a sign-off desk they can't use.
 */
/**
 * Reseeding an event's lanes.
 *
 * Not a queued write: unlike a tick or a time it is one deliberate decision
 * about a whole event, made at a desk with signal, and it needs the server's
 * answer — it refuses once anything has been recorded against the event.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  const access = await meetAccess(db, params.meetId, user);
  if (!mayEditMeet(access)) {
    throw new Response("Whoever is running this meet seeds it.", { status: 403 });
  }

  const { eventId } = (await request.json()) as { eventId: string };
  const detail = await meetDetail(db, params.meetId);
  if (!detail) throw new Response("No such meet", { status: 404 });

  const entrants = shuffle(detail.entries[eventId] ?? []);
  const rebuilt = reseedHeats(
    detail,
    params.meetId,
    eventId,
    entrants,
    detail.meet.laneCount,
  );
  // Refused: the event has times against it. The screen disables the control
  // for the same reason, so this is the backstop.
  if (!rebuilt) return { ok: false };

  await replaceHeats(db, params.meetId, eventId, rebuilt);
  return { ok: true };
}

export default function RunMeet() {
  const { detail: loaded, access } = useMeet();
  const pending = usePending();
  const send = useSend();
  const detail = useMemo(() => applyPending(loaded, pending), [loaded, pending]);
  const { meetId } = useParams();
  const { laneLayout: layout, timerId, nameOrder } = useViewPrefs();
  const meet = detail.meet;
  const roster = detail.athletes;

  /**
   * The clock, and the one place it lives.
   *
   * Component state. A stopwatch is a fact about the device holding it —
   * three timers behind one lane each start their own on the strobe, and
   * nobody's clock is anybody else's. It used to be a field on the meet, which
   * meant one person tapping START reached into every other device's copy and,
   * because starting a heat also cleared it, deleted times the phones had
   * already sent.
   */
  const reseed = useFetcher();
  const [clock, setClock] = useState<{
    heatId: string;
    startedAt: number;
    /** Lanes that already had a time when this run started. */
    alreadyTimed: number[];
  } | null>(null);
  const [view, setView] = useState<"control" | "stopwatch" | null>(null);
  const showing = view ?? (access.admin ? "control" : "stopwatch");

  const [editingLane, setEditingLane] = useState<number | null>(null);
  const [assigningLane, setAssigningLane] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Where this device is in the running order. Device state, read back from
  // storage once the meet is known — an administrator signing off event 4
  // while the deck swims event 6 is the normal case, not a conflict.
  const [progress, setProgressState] = useState<Progress>({
    eventIndex: 0,
    heatIndex: 0,
  });
  useEffect(() => {
    if (meetId) setProgressState(loadProgress(meetId));
  }, [meetId]);

  const eventIndex = Math.min(
    progress.eventIndex,
    Math.max(0, detail.events.length - 1),
  );
  const event = detail.events[eventIndex];
  const heats = useMemo(
    () => (event ? heatsForEvent(detail.heats, event.id) : []),
    [detail.heats, event],
  );
  const heatIndex = Math.min(progress.heatIndex, Math.max(0, heats.length - 1));
  const heat: Heat | undefined = heats[heatIndex];

  const running = heat != null && clock?.heatId === heat.id;

  // Derived, not stored: each lane's official time comes from the watches on
  // it, so several timers can be recording at once without colliding.
  const resultsByLane = useMemo(() => {
    const map = new Map<number, Result>();
    if (!heat) return map;
    for (const result of resultsForHeat(detail, heat)) map.set(result.lane, result);
    return map;
  }, [detail, heat]);

  /**
   * The lanes *this device* has stopped.
   *
   * The heat is complete when the person holding this stopwatch has taken
   * every lane in front of them — not when times turn up from the timing
   * phones. Reading the shared results instead meant a lane a phone submitted
   * mid-race counted as stopped here, and the clock could vanish from under a
   * coach while swimmers were still in the water.
   */
  const stoppedByMe = useMemo(() => {
    const lanes = new Set<number>();
    if (!heat) return lanes;
    for (const watch of detail.watches) {
      if (watch.heatId === heat.id && watch.timerId === timerId) {
        lanes.add(watch.lane);
      }
    }
    return lanes;
  }, [detail, heat, timerId]);

  const occupiedLanes = heat
    ? heat.lanes.map((id, i) => (id ? i + 1 : null)).filter((n): n is number => n !== null)
    : [];
  /**
   * Nothing left on this screen that still wants a time *for this run*.
   *
   * Either this device took the lane, or a time arrived on it from somebody
   * else since the clock started. All three parts were learned by running it:
   * counting only this device's watches left a coach who times two lanes
   * waiting forever on the four the phones cover; counting every result let a
   * phone end the heat while swimmers were in the water; and counting results
   * that predate the start made pressing START on a re-swim declare the heat
   * over on the spot.
   */
  const allStopped =
    occupiedLanes.length > 0 &&
    occupiedLanes.every(
      (lane) =>
        stoppedByMe.has(lane) ||
        (resultsByLane.has(lane) &&
          !(clock?.alreadyTimed ?? []).includes(lane)),
    );

  // Lanes already swum can't be reseeded out from under their times.
  const eventTouched = useMemo(
    () => heats.some((h) => heatTouched(detail, h)),
    [detail, heats],
  );

  /**
   * The three states of the action panel below the lanes: swimmers are still
   * in the water, the heat is complete, or nothing has been started. Exactly
   * one of these owns that space at any moment.
   */
  const clockRunning = running && !allStopped;
  const heatComplete = running && allStopped;

  // Anchored to the wall clock, and the frame loop stops as soon as the last
  // lane is in — there's nothing left to animate.
  const elapsed = useElapsed(clockRunning ? clock!.startedAt : null);
  useWakeLock(running);

  useEffect(() => {
    if (!heatComplete) setConfirmReset(false);
  }, [heatComplete]);

  const goToHeat = (nextEvent: number, nextHeat: number) => {
    if (!meetId) return;
    const next = { eventIndex: nextEvent, heatIndex: nextHeat };
    setProgressState(next);
    saveProgress(meetId, next);
    // Never carry a running clock across a heat change.
    setClock(null);
    setEditingLane(null);
    setAssigningLane(null);
  };

  const nextHeat = () => {
    if (heatIndex + 1 < heats.length) {
      goToHeat(eventIndex, heatIndex + 1);
    } else if (meet && eventIndex + 1 < detail.events.length) {
      goToHeat(eventIndex + 1, 0);
    }
  };

  const prevHeat = () => {
    if (heatIndex > 0) goToHeat(eventIndex, heatIndex - 1);
    else if (eventIndex > 0) goToHeat(eventIndex - 1, 0);
  };

  // The switcher only exists for people who have a real choice: an
  // administrator who also holds a watch. Showing it to a coach would offer a
  // screen whose every button the server refuses.
  const switcher = mayDecide(access) ? (
    <div className="mb-3">
      <Segmented
        value={showing}
        onChange={(next) => setView(next as "control" | "stopwatch")}
        options={[
          { value: "control", label: "Control" },
          { value: "stopwatch", label: "Stopwatch" },
        ]}
      />
    </div>
  ) : null;

  if (showing === "control") {
    return (
      <div>
        {switcher}
        <RunControl />
      </div>
    );
  }

  if (!event) {
    return (
      <>
        {switcher}
        <EmptyState title="No events yet">
          <Link
            to={`/meets/${meet.id}`}
            className="font-semibold text-blue-600 underline"
          >
            Add events under Info
          </Link>{" "}
          before running the meet.
        </EmptyState>
      </>
    );
  }

  const isLastHeat =
    heatIndex + 1 >= heats.length && eventIndex + 1 >= detail.events.length;

  return (
    <div className="space-y-3">
      {switcher}
      {/* Event navigation */}
      <div className="flex items-center gap-2">
        <Button
          size="md"
          aria-label="Previous event"
          disabled={clockRunning || eventIndex === 0}
          onClick={() => goToHeat(eventIndex - 1, 0)}
        >
          ‹
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-xl font-bold leading-tight">
            {eventName(event)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Event {eventIndex + 1} of {detail.events.length}
            {heats.length > 0 && ` · Heat ${heatIndex + 1} of ${heats.length}`}
          </p>
        </div>
        <Button
          size="md"
          aria-label="Next event"
          disabled={clockRunning || eventIndex + 1 >= detail.events.length}
          onClick={() => goToHeat(eventIndex + 1, 0)}
        >
          ›
        </Button>
      </div>

      {isDiving(event) ? (
        <DivingPanel
          detail={detail}
          event={event}
          roster={roster}
          nameOrder={nameOrder}
        />
      ) : heats.length === 0 || !heat ? (
        <EmptyState title="Nobody is entered in this event">
          <Link
            to={`/meets/${detail.meet.id}/entries`}
            className="font-semibold text-blue-600 underline"
          >
            Enter swimmers
          </Link>
          , then come back. You can also skip ahead with the arrows above.
        </EmptyState>
      ) : (
        <>
          {/* Lane buttons, arranged per the meet's layout option. */}
          <div
            className={`grid gap-2 ${
              layout === "grid" ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            {orderedLanes(heat.lanes.length, layout).map((lane) => (
              <LaneTile
                key={lane}
                lane={lane}
                athlete={findAthlete(roster, heat.lanes[lane - 1])}
                result={resultsByLane.get(lane)}
                stoppedHere={stoppedByMe.has(lane)}
                running={running}
                clockRunning={clockRunning}
                layout={layout}
                laneCount={heat.lanes.length}
                nameOrder={nameOrder}
                onStop={() => {
                  const at = Date.now();
                  send({
                    kind: "watch",
                    meetId: meet.id,
                    heatId: heat.id,
                    lane,
                    timerId,
                    timeMs: at - clock!.startedAt,
                    source: "stopwatch",
                    recordedAt: at,
                    startedAt: clock!.startedAt,
                    stoppedAt: at,
                  });
                }}
                onEdit={() => setEditingLane(lane)}
                onAssign={() => setAssigningLane(lane)}
              />
            ))}
          </div>

          {/* Action panel. One fixed-height block in the easiest place to
              reach with a thumb, holding whichever of the three states is
              current — so the lane grid above it never shifts. */}
          {clockRunning ? (
            <div className="flex min-h-24 items-center justify-center rounded-2xl bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-white">
              <span className="text-6xl font-bold leading-none tabular-nums">
                {formatClock(elapsed)}
              </span>
            </div>
          ) : heatComplete && confirmReset ? (
            /* Cancel sits where Reset just was, so a double tap lands on the
               harmless half rather than erasing the heat. */
            <div className="grid min-h-24 grid-cols-2 gap-2">
              <Button
                size="xl"
                className="!min-h-24 !text-xl"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="xl"
                className="!min-h-24 !text-xl"
                onClick={() => {
                  // This device's own watches, and nobody else's. A timer at
                  // the far end of the pool doesn't lose their afternoon
                  // because somebody reset a heat here.
                  send({
                    kind: "clear-watches",
                    meetId: meet.id,
                    heatId: heat.id,
                    timerId,
                  });
                  setClock(null);
                  setConfirmReset(false);
                }}
              >
                Erase {stoppedByMe.size} time
                {stoppedByMe.size === 1 ? "" : "s"}
              </Button>
            </div>
          ) : heatComplete ? (
            <div className="grid min-h-24 grid-cols-2 gap-2">
              <Button
                size="xl"
                className="!min-h-24"
                onClick={() => setConfirmReset(true)}
              >
                Reset
              </Button>
              <Button
                variant="primary"
                size="xl"
                className="!min-h-24"
                onClick={nextHeat}
                disabled={isLastHeat}
              >
                {heatIndex + 1 < heats.length ? "Next heat" : "Next event"}
              </Button>
            </div>
          ) : (
            <Button
              variant="success"
              size="xl"
              full
              className="!min-h-24 !text-4xl"
              onClick={() => {
                // A false start's watches aren't times of the race about to
                // be swum, so this device drops its own before starting.
                send({
                  kind: "clear-watches",
                  meetId: meet.id,
                  heatId: heat.id,
                  timerId,
                });
                // Whatever else is already on these lanes belongs to the
                // previous swim, not this one.
                setClock({
                  heatId: heat.id,
                  startedAt: Date.now(),
                  alreadyTimed: [...resultsByLane.keys()],
                });
              }}
            >
              START
            </Button>
          )}

          {!running && (
            <div className="grid grid-cols-3 gap-2">
              <Button size="sm" onClick={prevHeat} disabled={eventIndex === 0 && heatIndex === 0}>
                ‹ Back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={eventTouched}
                title={
                  eventTouched
                    ? "This event has times against it — reseeding would move swimmers out from under them."
                    : undefined
                }
                onClick={() => reseed.submit({ eventId: event.id }, { method: "post", action: `/meets/${meet.id}/run`, encType: "application/json" })}
              >
                Reseed lanes
              </Button>
              <Button size="sm" onClick={nextHeat} disabled={isLastHeat}>
                Skip ›
              </Button>
            </div>
          )}

          {!running && resultsByLane.size > 0 && (
            <Banner tone="info">
              This heat already has {resultsByLane.size} time
              {resultsByLane.size === 1 ? "" : "s"}
              {stoppedByMe.size > 0
                ? `, ${stoppedByMe.size} of them taken here. Starting again clears those and leaves the rest.`
                : ", none of them taken here. Starting again leaves them alone."}
            </Banner>
          )}
        </>
      )}

      {heat && assigningLane !== null && (
        <LaneAssignSheet
          detail={detail}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          heat={heat}
          lane={assigningLane}
          onAssign={(athleteId) =>
            send({
              kind: "seat",
              meetId: meet.id,
              heatId: heat.id,
              lane: assigningLane,
              athleteId,
            })
          }
          onClose={() => setAssigningLane(null)}
        />
      )}

      {heat && editingLane !== null && (
        <LaneSheet
          heat={heat}
          lane={editingLane}
          onClose={() => setEditingLane(null)}
          result={resultsByLane.get(editingLane)}
          swimmerLabel={(() => {
            const s = findAthlete(roster, heat.lanes[editingLane - 1]);
            return s ? displayName(s, nameOrder) : `Lane ${editingLane}`;
          })()}
          watches={watchesForLane(detail, heat.id, editingLane)}
          timerId={timerId}
          onSaveTime={(timeMs) => {
            send({
              kind: "watch",
              meetId: meet.id,
              heatId: heat.id,
              lane: editingLane,
              timerId,
              timeMs,
              source: "typed",
              recordedAt: Date.now(),
            });
            setEditingLane(null);
          }}
          onRemoveWatch={(who) =>
            send({
              kind: "drop-watch",
              meetId: meet.id,
              heatId: heat.id,
              lane: editingLane,
              timerId: who,
            })
          }
          onRemoveFromLane={() => {
            send({
              kind: "unseat",
              meetId: meet.id,
              heatId: heat.id,
              lane: editingLane,
            });
            setEditingLane(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Diving keeps its place in the running order so the event numbers match the
 * printed program, but there is nothing to time here — the board runs on its
 * own sheet. All this does is show who's on it and let you move past.
 */
function DivingPanel({
  detail,
  event,
  roster,
  nameOrder,
}: {
  detail: MeetDetail;
  event: MeetEvent;
  roster: Athlete[];
  nameOrder: NameOrder;
}) {
  const divers = (detail.entries[event.id] ?? [])
    .map((id) => findAthlete(roster, id))
    .filter((s): s is Athlete => s !== undefined)
    .sort(byAthlete(nameOrder));

  return (
    <div className="rounded-2xl bg-sky-50 p-4 dark:bg-sky-950/40">
      <p className="text-sm font-semibold text-sky-900 dark:text-sky-100">
        Diving isn&rsquo;t timed here — scored on the diving sheet.
      </p>
      {divers.length === 0 ? (
        <p className="mt-2 text-sm text-sky-800 dark:text-sky-200">
          Nobody is on the board.{" "}
          <Link
            to={`/meets/${detail.meet.id}/entries`}
            className="font-semibold underline"
          >
            Add divers
          </Link>{" "}
          if that&rsquo;s not right.
        </p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {divers.map((diver) => (
            <li
              key={diver.id}
              className="text-base font-semibold text-sky-900 dark:text-sky-100"
            >
              {displayName(diver, nameOrder)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-sky-700 dark:text-sky-300">
        Use the arrows above to carry on with the next event.
      </p>
    </div>
  );
}

/**
 * Fix a lane after the fact: a missed stop button, a fat-fingered tap, or a DQ.
 * Without this a single mistake would cost the whole heat.
 */
function LaneSheet({
  heat,
  lane,
  swimmerLabel,
  result,
  watches,
  timerId,
  onClose,
  onSaveTime,
  onRemoveWatch,
  onRemoveFromLane,
}: {
  heat: Heat;
  lane: number;
  swimmerLabel: string;
  result?: Result;
  /** Every watch on this lane, so a coach can see what the time is made of. */
  watches: Watch[];
  timerId: string;
  onClose: () => void;
  onSaveTime: (timeMs: number) => void;
  onRemoveWatch: (watchId: string) => void;
  onRemoveFromLane: () => void;
}) {
  // Prefilled with this device's own watch, since typing a time replaces that
  // one — never somebody else's.
  const own = watches.find((w) => w.timerId === timerId);
  const [value, setValue] = useState(own ? formatTime(own.timeMs) : "");
  const empty = heat.lanes[lane - 1] === null;

  // Parsed on every keystroke so the sheet can show what will actually be
  // saved — "101.45" becoming 1:01.45 should never be a surprise.
  const parsed = parseTime(value);
  const typed = value.trim() !== "";

  return (
    <Sheet open title={`Lane ${lane} · ${swimmerLabel}`} onClose={onClose}>
      {empty ? (
        <p className="text-slate-500">This lane is empty for this heat.</p>
      ) : (
        <div className="space-y-3">
          <Field
            label="Time"
            hint={'Just digits \u2014 "3045" is 30.45, "11127" is 1:11.27.'}
          >
            <TextInput
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder="11127"
              autoFocus
            />
          </Field>

          {typed &&
            (parsed !== null ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Saves as{" "}
                <strong className="text-base tabular-nums text-slate-900 dark:text-white">
                  {formatTime(parsed)}
                </strong>
              </p>
            ) : (
              <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                Can&rsquo;t read that as a time. Try 3045 for 30.45, or 11127
                for 1:11.27.
              </p>
            ))}

          <Button
            variant="primary"
            size="lg"
            full
            disabled={parsed === null}
            onClick={() => parsed !== null && onSaveTime(parsed)}
          >
            {own ? "Replace my time" : "Save time"}
          </Button>

          {watches.length > 0 && (
            <div className="rounded-2xl bg-slate-100 p-3 dark:bg-slate-800">
              <p className="mb-1 text-xs font-bold text-slate-600 dark:text-slate-300">
                {watches.length} watch{watches.length === 1 ? "" : "es"} on this
                lane
                {result && result.method !== "official" && (
                  <span className="font-normal">
                    {" "}
                    · official {formatTime(result.timeMs)} (
                    {METHOD_LABEL[result.method]})
                  </span>
                )}
              </p>
              <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                {watches.map((watch) => (
                  <li
                    key={watch.timerId}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <span className="text-sm tabular-nums">
                      {formatTime(watch.timeMs)}
                      <span className="ml-2 text-xs text-slate-500">
                        {watch.timerId === timerId ? "you" : "another timer"}
                        {watch.source === "typed" && " · typed"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Discard the ${formatTime(watch.timeMs)} watch`}
                      onClick={() => onRemoveWatch(watch.timerId)}
                      className="h-8 w-8 shrink-0 touch-manipulation rounded-lg text-sm text-red-600"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* A DQ, a no-show and signing a lane off are calls, and a call is
              a decision — it belongs at the control desk, where the person
              making it can see every watch on the lane. The deck's job is
              evidence: take a time, fix your own, say who's in the lane. */}
          {!result && (
            /* Undo for a wrong pick. Only offered while the lane has no time
               on it — otherwise clear the time first. */
            <Button variant="ghost" full onClick={onRemoveFromLane}>
              Remove from lane
            </Button>
          )}
        </div>
      )}
    </Sheet>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Route } from "./+types/run";
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
import { heatsForEvent } from "~/lib/heats";
import { heatTouched, resultsForHeat, watchesForLane } from "~/lib/timing";
import { loadProgress, saveProgress } from "~/lib/storage";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex, rosterForMeet, seasonForMeet } from "~/lib/roster";
import { useAppStore } from "~/state/app-store";
import { useMeetRole } from "~/state/meet-role";
import { useRunClock } from "~/state/run-clock";
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
  type MeetDoc,
  type MeetEvent,
  type NameOrder,
  type Progress,
  type Result,
  type Athlete,
  type WatchTime,
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
export default function RunMeet() {
  const store = useAppStore();
  const { meetId } = useParams();
  const role = useMeetRole();
  const clock = useRunClock();
  const { laneLayout: layout, timerId, nameOrder } = useViewPrefs();
  const meet = store.meets.find((m) => m.id === meetId);
  const roster = store.athletes;
  const [view, setView] = useState<"control" | "stopwatch" | null>(null);
  const showing = view ?? (role.admin ? "control" : "stopwatch");

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
    Math.max(0, (meet?.events.length ?? 1) - 1),
  );
  const event = meet?.events[eventIndex];
  const heats = useMemo(
    () => (meet && event ? heatsForEvent(meet, event.id) : []),
    [meet, event],
  );
  const heatIndex = Math.min(progress.heatIndex, Math.max(0, heats.length - 1));
  const heat: Heat | undefined = heats[heatIndex];

  // Seed heats the first time we land on an event. Diving never gets heats —
  // it's in the lineup so divers can see it, not to be run from here.
  useEffect(() => {
    if (meet && event && !isDiving(event)) store.ensureHeats(meet.id, event.id);
  }, [meet, event, store]);

  const running = heat != null && clock.clock?.heatId === heat.id;

  // Derived, not stored: each lane's official time comes from the watches on
  // it, so several timers can be recording at once without colliding.
  const resultsByLane = useMemo(() => {
    const map = new Map<number, Result>();
    if (!meet || !heat) return map;
    for (const result of resultsForHeat(meet, heat)) map.set(result.lane, result);
    return map;
  }, [meet, heat]);

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
    if (!meet || !heat) return lanes;
    for (const watch of meet.watches) {
      if (watch.heatId === heat.id && watch.timerId === timerId) {
        lanes.add(watch.lane);
      }
    }
    return lanes;
  }, [meet, heat, timerId]);

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
          !(clock.clock?.alreadyTimed ?? []).includes(lane)),
    );

  // Lanes already swum can't be reseeded out from under their times.
  const eventTouched = useMemo(
    () => (meet ? heats.some((h) => heatTouched(meet, h)) : false),
    [meet, heats],
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
  const elapsed = useElapsed(clockRunning ? clock.clock!.startedAt : null);
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
    clock.stop();
    setEditingLane(null);
    setAssigningLane(null);
  };

  const nextHeat = () => {
    if (heatIndex + 1 < heats.length) {
      goToHeat(eventIndex, heatIndex + 1);
    } else if (meet && eventIndex + 1 < meet.events.length) {
      goToHeat(eventIndex + 1, 0);
    }
  };

  const prevHeat = () => {
    if (heatIndex > 0) goToHeat(eventIndex, heatIndex - 1);
    else if (eventIndex > 0) goToHeat(eventIndex - 1, 0);
  };

  if (!meet) return null;

  // The switcher only exists for people who have a real choice: an
  // administrator who also holds a watch. Showing it to a coach would offer a
  // screen whose every button the server refuses.
  const switcher = role.admin ? (
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
        <RunControl meet={meet} />
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
    heatIndex + 1 >= heats.length && eventIndex + 1 >= meet.events.length;

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
            Event {eventIndex + 1} of {meet.events.length}
            {heats.length > 0 && ` · Heat ${heatIndex + 1} of ${heats.length}`}
          </p>
        </div>
        <Button
          size="md"
          aria-label="Next event"
          disabled={clockRunning || eventIndex + 1 >= meet.events.length}
          onClick={() => goToHeat(eventIndex + 1, 0)}
        >
          ›
        </Button>
      </div>

      {isDiving(event) ? (
        <DivingPanel
          meet={meet}
          event={event}
          roster={roster}
          nameOrder={nameOrder}
        />
      ) : heats.length === 0 || !heat ? (
        <EmptyState title="Nobody is entered in this event">
          <Link
            to={`/meets/${meet.id}/registration`}
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
                onStop={() =>
                  store.stopLane(
                    meet.id,
                    heat,
                    lane,
                    Date.now() - clock.clock!.startedAt,
                    timerId,
                  )
                }
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
                  store.clearOwnWatches(meet.id, heat.id, timerId);
                  clock.stop();
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
                store.clearOwnWatches(meet.id, heat.id, timerId);
                // Whatever else is already on these lanes belongs to the
                // previous swim, not this one.
                clock.start(heat.id, [...resultsByLane.keys()]);
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
                onClick={() => store.rebuildHeats(meet.id, event.id, { shuffle: true })}
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
          meet={meet}
          roster={rosterForMeet(store.athletes, store.team, meet)}
          enrollments={enrollmentIndex(
            store.team,
            seasonForMeet(store.team, meet)?.id,
          )}
          nameOrder={nameOrder}
          heat={heat}
          lane={assigningLane}
          onAssign={(athleteId) =>
            store.assignToLane(meet.id, heat.id, assigningLane, athleteId)
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
          watches={watchesForLane(meet, heat.id, editingLane)}
          timerId={timerId}
          onSaveTime={(timeMs) => {
            store.recordManualTime(meet.id, heat, editingLane, timeMs, timerId);
            setEditingLane(null);
          }}
          onStatus={(status) => {
            store.setLaneStatus(meet.id, heat, editingLane, status);
            setEditingLane(null);
          }}
          onClear={() => {
            store.clearLaneTimes(meet.id, heat, editingLane);
            setEditingLane(null);
          }}
          onRemoveWatch={(id) => store.removeWatch(meet.id, id)}
          onRemoveFromLane={() => {
            store.clearLane(meet.id, heat.id, editingLane);
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
  meet,
  event,
  roster,
  nameOrder,
}: {
  meet: MeetDoc;
  event: MeetEvent;
  roster: Athlete[];
  nameOrder: NameOrder;
}) {
  const divers = (meet.entries[event.id] ?? [])
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
            to={`/meets/${meet.id}/registration`}
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
  onStatus,
  onClear,
  onRemoveWatch,
  onRemoveFromLane,
}: {
  heat: Heat;
  lane: number;
  swimmerLabel: string;
  result?: Result;
  /** Every watch on this lane, so a coach can see what the time is made of. */
  watches: WatchTime[];
  timerId: string;
  onClose: () => void;
  onSaveTime: (timeMs: number) => void;
  onStatus: (status: "OK" | "DQ" | "NS") => void;
  onClear: () => void;
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
                    key={watch.id}
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
                      onClick={() => onRemoveWatch(watch.id)}
                      className="h-8 w-8 shrink-0 touch-manipulation rounded-lg text-sm text-red-600"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => onStatus("DQ")} disabled={!result}>
              Mark DQ
            </Button>
            <Button onClick={() => onStatus("NS")} disabled={!result}>
              Mark no-show
            </Button>
          </div>
          {result ? (
            <Button variant="ghost" full onClick={onClear}>
              Clear this lane&rsquo;s times
            </Button>
          ) : (
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

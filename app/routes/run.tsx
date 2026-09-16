import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Route } from "./+types/run";
import type { SwimTime } from "~/lib/timing";
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
import { useLiveData } from "~/hooks/use-live-data";
import { reseedEvent, shuffle } from "~/lib/heats";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { mayEditMeet } from "~/lib/access";
import { meetAccess } from "~/lib/access.server";
import { meetDetail, replaceSeeds } from "~/lib/meets.server";
import {
  eventTouched,
  fromStopwatch,
  heatsOf,
  seedsForHeat,
  swimTime,
  watchesOn,
} from "~/lib/timing";
import { loadProgress, saveProgress } from "~/lib/storage";

import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { mayDecide } from "~/lib/access";
import { applyPending } from "~/lib/pending";
import { generateId } from "~/lib/id";
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
  type MeetDetail,
  type MeetEvent,
  type NameOrder,
  type Seed,
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
    throw new Response("Whoever is running this meet seeds it.", {
      status: 403,
    });
  }

  const { eventId } = (await request.json()) as { eventId: string };
  const detail = await meetDetail(db, params.meetId);
  if (!detail) throw new Response("No such meet", { status: 404 });

  const entrants = shuffle(detail.entries[eventId] ?? []);
  const rebuilt = reseedEvent(
    detail,
    params.meetId,
    eventId,
    entrants,
    detail.meet.laneCount,
  );
  // Refused: the event has times against it. The screen disables the control
  // for the same reason, so this is the backstop.
  if (!rebuilt) return { ok: false };

  await replaceSeeds(db, params.meetId, eventId, rebuilt);
  return { ok: true };
}

export default function RunMeet() {
  const { detail: loaded, access } = useMeet();
  const pending = usePending();
  const send = useSend();
  const detail = useMemo(
    () => applyPending(loaded, pending),
    [loaded, pending],
  );
  const { meetId } = useParams();
  const { laneLayout: layout, timerId, nameOrder } = useViewPrefs();

  /**
   * Who this screen's watches belong to.
   *
   * A signed-in coach is the *person*, not the iPad — so the watch they take
   * on lane 3 is theirs whichever device they pick up, and switching devices
   * mid-meet doesn't leave two watches on one lane disagreeing. The device id
   * is the fallback for anyone with no account, which on this screen means
   * nobody today and is the honest default rather than a guess.
   */
  const mine = access.userId ?? timerId;

  /**
   * What a watch taken on this screen is worth.
   *
   * The same screen serves an administrator who also holds a stopwatch and a
   * coach who only does, and their readings are not weighed the same — so it
   * follows whoever is looking rather than the screen they are on. The server
   * decides it again from the session; this keeps the optimistic overlay in
   * step until it answers.
   */
  const myRole = access.admin ? "admin" : access.userId ? "coach" : "timer";

  // Both halves of this screen are watching other people work: the desk for
  // times arriving from the phones, the deck for a lane reseated at the desk.
  // One call covers both, since the control view renders inside this one.
  useLiveData();
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
    eventId: string;
    heat: number;
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
    () => (event ? heatsOf(detail, event.id) : []),
    [detail, event],
  );
  const heatIndex = Math.min(progress.heatIndex, Math.max(0, heats.length - 1));
  const heat: number | undefined = heats[heatIndex];

  /** The swims in the heat on screen. A lane with nobody in it isn't one. */
  const seeds = useMemo(
    () =>
      event && heat !== undefined ? seedsForHeat(detail, event.id, heat) : [],
    [detail, event, heat],
  );
  const seedByLane = useMemo(
    () => new Map(seeds.map((s) => [s.lane, s] as const)),
    [seeds],
  );

  const running =
    heat !== undefined && clock?.heat === heat && clock?.eventId === event?.id;

  // Derived, not stored: each lane's time comes from the watches on it, so
  // several timers can be recording at once without colliding.
  const timeByLane = useMemo(() => {
    const map = new Map<number, NonNullable<ReturnType<typeof swimTime>>>();
    for (const seed of seeds) {
      const time = swimTime(detail, seed.id);
      if (time) map.set(seed.lane, time);
    }
    return map;
  }, [detail, seeds]);

  /**
   * The lanes *this device* has stopped.
   *
   * The heat is complete when the person holding this stopwatch has taken
   * every lane in front of them — not when times turn up from the timing
   * phones. Reading the shared times instead meant a lane a phone submitted
   * mid-race counted as stopped here, and the clock could vanish from under a
   * coach while swimmers were still in the water.
   */
  const stoppedByMe = useMemo(() => {
    const lanes = new Set<number>();
    for (const seed of seeds) {
      if (
        watchesOn(detail, seed.id).some(
          (w) => w.timerId === mine && w.timeMs !== undefined,
        )
      ) {
        lanes.add(seed.lane);
      }
    }
    return lanes;
  }, [detail, seeds, mine]);

  const occupiedLanes = seeds.map((s) => s.lane);

  /**
   * Nothing left on this screen that still wants a time *for this run*.
   *
   * Either this device took the lane, or a time arrived on it from somebody
   * else since the clock started. All three parts were learned by running it:
   * counting only this device's watches left a coach who times two lanes
   * waiting forever on the four the phones cover; counting every time let a
   * phone end the heat while swimmers were in the water; and counting times
   * that predate the start made pressing START on a re-swim declare the heat
   * over on the spot.
   */
  const allStopped =
    occupiedLanes.length > 0 &&
    occupiedLanes.every(
      (lane) =>
        stoppedByMe.has(lane) ||
        (timeByLane.has(lane) && !(clock?.alreadyTimed ?? []).includes(lane)),
    );

  // Swims already recorded can't be reseeded out from under their times.
  const touched = useMemo(
    () => (event ? eventTouched(detail, event.id) : false),
    [detail, event],
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
            {orderedLanes(meet.laneCount, layout).map((lane) => (
              <LaneTile
                key={lane}
                lane={lane}
                athlete={findAthlete(
                  roster,
                  seedByLane.get(lane)?.athleteId ?? null,
                )}
                time={timeByLane.get(lane)}
                stoppedHere={stoppedByMe.has(lane)}
                running={running}
                clockRunning={clockRunning}
                layout={layout}
                laneCount={meet.laneCount}
                nameOrder={nameOrder}
                onStop={() => {
                  const seed = seedByLane.get(lane);
                  if (!seed) return;
                  const at = Date.now();
                  send({
                    kind: "watch",
                    meetId: meet.id,
                    seedId: seed.id,
                    timerId: mine,
                    userId: access.userId ?? undefined,
                    role: myRole,
                    timeMs: at - clock!.startedAt,
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
                  for (const seed of seeds) {
                    send({
                      kind: "drop-watch",
                      meetId: meet.id,
                      seedId: seed.id,
                      timerId: mine,
                    });
                  }
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
                for (const seed of seeds) {
                  send({
                    kind: "drop-watch",
                    meetId: meet.id,
                    seedId: seed.id,
                    timerId: mine,
                  });
                }
                // Whatever else is already on these lanes belongs to the
                // previous swim, not this one.
                setClock({
                  eventId: event.id,
                  heat: heat!,
                  startedAt: Date.now(),
                  alreadyTimed: [...timeByLane.keys()],
                });
              }}
            >
              START
            </Button>
          )}

          {!running && (
            <div className="grid grid-cols-3 gap-2">
              <Button
                size="sm"
                onClick={prevHeat}
                disabled={eventIndex === 0 && heatIndex === 0}
              >
                ‹ Back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={touched}
                title={
                  touched
                    ? "This event has times against it — reseeding would move swimmers out from under them."
                    : undefined
                }
                onClick={() =>
                  reseed.submit(
                    { eventId: event.id },
                    {
                      method: "post",
                      action: `/meets/${meet.id}/run`,
                      encType: "application/json",
                    },
                  )
                }
              >
                Reseed lanes
              </Button>
              <Button size="sm" onClick={nextHeat} disabled={isLastHeat}>
                Skip ›
              </Button>
            </div>
          )}

          {!running && timeByLane.size > 0 && (
            <Banner tone="info">
              This heat already has {timeByLane.size} time
              {timeByLane.size === 1 ? "" : "s"}
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
          eventId={event.id}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          heat={heat}
          lane={assigningLane}
          onAssign={(athleteId) =>
            send({
              kind: "seed",
              meetId: meet.id,
              eventId: event.id,
              heat: heat!,
              lane: assigningLane,
              athleteId,
              seedId: generateId(),
            })
          }
          onClose={() => setAssigningLane(null)}
        />
      )}

      {editingLane !== null &&
        (() => {
          const seed = seedByLane.get(editingLane);
          if (!seed) return null;
          const athlete = findAthlete(roster, seed.athleteId);
          return (
            <LaneSheet
              lane={editingLane}
              onClose={() => setEditingLane(null)}
              time={timeByLane.get(editingLane)}
              swimmerLabel={
                athlete
                  ? displayName(athlete, nameOrder)
                  : `Lane ${editingLane}`
              }
              watches={watchesOn(detail, seed.id).filter(
                (w) => w.timeMs !== undefined,
              )}
              timerId={mine}
              onSaveTime={(timeMs) => {
                send({
                  kind: "watch",
                  meetId: meet.id,
                  seedId: seed.id,
                  timerId: mine,
                  userId: access.userId ?? undefined,
                  role: myRole,
                  timeMs,
                  recordedAt: Date.now(),
                });
                setEditingLane(null);
              }}
              onRemoveWatch={(who) =>
                send({
                  kind: "drop-watch",
                  meetId: meet.id,
                  seedId: seed.id,
                  timerId: who,
                })
              }
              onRemoveFromLane={() => {
                send({ kind: "unseed", meetId: meet.id, seedId: seed.id });
                setEditingLane(null);
              }}
            />
          );
        })()}
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
  lane,
  swimmerLabel,
  time,
  watches,
  timerId,
  onClose,
  onSaveTime,
  onRemoveWatch,
  onRemoveFromLane,
}: {
  lane: number;
  swimmerLabel: string;
  time?: SwimTime;
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
  const [value, setValue] = useState(own ? formatTime(own.timeMs!) : "");

  // Parsed on every keystroke so the sheet can show what will actually be
  // saved — "101.45" becoming 1:01.45 should never be a surprise.
  const parsed = parseTime(value);
  const typed = value.trim() !== "";

  return (
    <Sheet open title={`Lane ${lane} · ${swimmerLabel}`} onClose={onClose}>
      {
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
                {time && !time.official && (
                  <span className="font-normal">
                    {" "}
                    · official {formatTime(time.timeMs)} (
                    {METHOD_LABEL[time.method]})
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
                      {formatTime(watch.timeMs!)}
                      <span className="ml-2 text-xs text-slate-500">
                        {watch.timerId === timerId ? "you" : "another timer"}
                        {!fromStopwatch(watch) && " · typed"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Discard the ${formatTime(watch.timeMs!)} watch`}
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
          {!time?.official && (
            /* Undo for a wrong pick. Only offered while the lane has no time
               on it — otherwise clear the time first. */
            <Button variant="ghost" full onClick={onRemoveFromLane}>
              Remove from lane
            </Button>
          )}
        </div>
      }
    </Sheet>
  );
}

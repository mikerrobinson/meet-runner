import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/timer";
import { Button } from "~/components/ui";
import { SwimmerPicker } from "~/components/SwimmerPicker";
import { formatClock, formatTime } from "~/lib/time";
import { loadTimerId } from "~/lib/storage";
import {
  earliestAllowed,
  enqueue,
  fetchSnapshot,
  flush,
  loadGrant,
  loadLane,
  clearLane,
  loadPosition,
  queueSize,
  runningOrder,
  saveLane,
  savePosition,
  type Position,
  type QueuedAthlete,
  type Snapshot,
  type TimerAthlete,
} from "~/lib/timer";
import { eventName, watchId } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Meet Runner" }];
}

/**
 * The stopwatch a volunteer holds behind a lane.
 *
 * The whole screen is built around one assumption: the person using it is
 * untrained, distracted, and should be watching the water rather than the
 * phone. So there is exactly one big button at any moment, the current swimmer
 * is stated rather than chosen, and nothing that isn't the next thing to do
 * competes for the thumb.
 *
 * It is also deliberately alone. No shared heat state, no coach driving it
 * from elsewhere: this timer starts and stops their own watch, submits, and
 * moves on. Pool wifi may be gone the entire time and nothing here notices —
 * times queue and go up when they can.
 */
export default function Timer() {
  const timerId = useMemo(() => loadTimerId(), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<number | null>(null);
  const [position, setPosition] = useState<Position>({ at: 0, submitted: -1 });
  const [picking, setPicking] = useState(false);
  const [waiting, setWaiting] = useState(0);

  // Who this timer says is in the lane, per heat, before it's been submitted.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Swimmers typed in on this device; they may not have reached the server yet.
  // `QueuedAthlete`, not `Athlete`: each carries the team the timer tapped, and
  // that has to survive into the outbox for the server to enrol them.
  const [added, setAdded] = useState<QueuedAthlete[]>([]);

  /* --------------------------------------------------------------- loading */

  const load = useCallback(async () => {
    if (!loadGrant()) {
      setError("Scan the code your coach gave you to start timing.");
      return;
    }
    try {
      setSnapshot(await fetchSnapshot(timerId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the meet.");
    }
  }, [timerId]);

  useEffect(() => {
    setLane(loadLane());
    setPosition(loadPosition());
    setWaiting(queueSize());
    void load();
  }, [load]);

  // Anything stuck in the outbox goes out when the signal comes back, and when
  // the phone is picked up again. Neither is guaranteed to happen, which is why
  // submitting also flushes.
  useEffect(() => {
    const drain = () => {
      void flush().then(() => setWaiting(queueSize()));
    };
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", drain);
    const timer = setInterval(drain, 20_000);
    return () => {
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", drain);
      clearInterval(timer);
    };
  }, []);

  /* ------------------------------------------------------------- stopwatch */

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopped, setStopped] = useState<{ ms: number; at: number } | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => {
      setElapsed(Date.now() - startedAt);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [startedAt]);

  /* ----------------------------------------------------------------- state */

  const order = useMemo(
    () => (snapshot ? runningOrder(snapshot.events, snapshot.heats) : []),
    [snapshot],
  );
  const stop = order[Math.min(position.at, order.length - 1)];
  const floor = earliestAllowed(position);

  const athletes = useMemo(() => {
    if (!snapshot) return [];
    const seen = new Set(snapshot.athletes.map((a) => a.id));
    return [
      ...snapshot.athletes,
      ...added.filter((a) => !seen.has(a.id)),
    ] as TimerAthlete[];
  }, [snapshot, added]);

  const byId = useMemo(
    () => new Map(athletes.map((a) => [a.id, a])),
    [athletes],
  );

  const ownTeam = snapshot?.ownTeam ?? "Home";
  const laneKey = stop && lane ? `${stop.heat.id}:${lane}` : "";
  const seatedId = stop && lane ? stop.heat.lanes[lane - 1] : null;
  const swimmerId = overrides[laneKey] ?? seatedId ?? null;
  const swimmer = swimmerId ? byId.get(swimmerId) : undefined;

  const alreadyTimed = useMemo(() => {
    if (!snapshot || !stop || !lane) return undefined;
    return snapshot.mine.find(
      (watch) => watch.heatId === stop.heat.id && watch.lane === lane,
    );
  }, [snapshot, stop, lane]);

  /* --------------------------------------------------------------- actions */

  const move = (to: number) => {
    const next = { ...position, at: Math.max(floor, Math.min(order.length - 1, to)) };
    setPosition(next);
    savePosition(next);
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
  };

  const submit = async () => {
    if (!stop || !lane || !stopped) return;
    const watch = {
      id: watchId(stop.heat.id, lane, timerId),
      eventId: stop.event.id,
      heatId: stop.heat.id,
      lane,
      timerId,
      timeMs: stopped.ms,
      recordedAt: Date.now(),
      source: "stopwatch" as const,
      athleteId: swimmerId ?? undefined,
      startedAt: stopped.at - stopped.ms,
      stoppedAt: stopped.at,
    };
    // The swimmer travels with the time when they were typed in here, so a
    // phone with no signal can still hand over both together later.
    const newcomers = added.filter((a) => a.id === swimmerId);
    enqueue({ watches: [watch], athletes: newcomers });

    const next = {
      at: Math.min(order.length - 1, position.at + 1),
      submitted: Math.max(position.submitted, position.at),
    };
    setPosition(next);
    savePosition(next);
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);

    // A failure here is not worth reporting: the time is already in the
    // outbox, the header says how many are waiting, and the next attempt is
    // twenty seconds away. What matters is that the screen has already moved
    // on to the next heat.
    await flush();
    setWaiting(queueSize());
  };

  /* ---------------------------------------------------------------- render */

  if (error && !snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-bold">Not timing yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{error}</p>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  // Standing behind a lane is the first thing that happens, and until it's
  // answered nothing else on this screen means anything.
  if (lane === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <h1 className="mb-1 text-center text-xl font-bold">{snapshot.meet.name}</h1>
        <p className="mb-6 text-center text-slate-600 dark:text-slate-300">
          Which lane are you timing?
        </p>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: snapshot.meet.laneCount }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                saveLane(n);
                setLane(n);
              }}
              className="min-h-24 touch-manipulation rounded-2xl border-2 border-slate-300 text-4xl font-bold active:bg-blue-600 active:text-white dark:border-slate-700"
            >
              {n}
            </button>
          ))}
        </div>
      </main>
    );
  }

  if (!stop) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-bold">Nothing to time yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            The coach hasn&rsquo;t set the heats for this meet. This screen will
            catch up on its own.
          </p>
          <div className="mt-4">
            <Button onClick={() => void load()}>Check again</Button>
          </div>
        </div>
      </main>
    );
  }

  const running = startedAt !== null && !stopped;
  const inEvent = new Set(snapshot.entries[stop.event.id] ?? []);

  return (
    <main className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Where we are. Small: it's context, not the job. */}
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] dark:border-slate-800 dark:bg-slate-900">
        <Button
          size="sm"
          variant="ghost"
          disabled={running || position.at <= floor}
          onClick={() => move(position.at - 1)}
          aria-label="Previous heat"
        >
          ‹
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-bold">{eventName(stop.event)}</p>
          <p className="text-xs text-slate-500">
            Heat {stop.number} of {stop.of}
            {waiting > 0 && ` · ${waiting} to send`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={running || position.at >= order.length - 1}
          onClick={() => move(position.at + 1)}
          aria-label="Next heat"
        >
          ›
        </Button>
      </header>

      <div className="flex flex-1 flex-col justify-between p-4">
        <div className="space-y-3">
          <button
            type="button"
            disabled={running}
            onClick={() => {
              clearLane();
              setLane(null);
            }}
            className="flex w-full touch-manipulation items-center justify-between rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900"
          >
            <span className="text-3xl font-bold">Lane {lane}</span>
            <span className="text-sm font-semibold text-blue-600">change</span>
          </button>

          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex w-full touch-manipulation items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900"
          >
            <span className="min-w-0">
              <span className="block truncate text-2xl font-bold">
                {swimmer ? `${swimmer.firstName} ${swimmer.lastName}`.trim() : "Empty lane"}
              </span>
              <span className="block truncate text-sm text-slate-500">
                {swimmer ? (swimmer.team ?? ownTeam) : "Tap to say who's here"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-blue-600">change</span>
          </button>
        </div>

        <div className="py-6 text-center">
          <p className="font-mono text-6xl font-bold tabular-nums">
            {stopped ? formatTime(stopped.ms) : formatClock(elapsed)}
          </p>
          {alreadyTimed && !stopped && startedAt === null && (
            <p className="mt-2 text-sm text-slate-500">
              Already sent {formatTime(alreadyTimed.timeMs)} for this heat.
              Timing again replaces it.
            </p>
          )}
        </div>

        <div className="space-y-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {stopped ? (
            <div className="grid grid-cols-3 gap-2">
              <Button
                size="xl"
                variant="success"
                className="col-span-2"
                onClick={() => void submit()}
              >
                Submit
              </Button>
              <Button
                size="xl"
                onClick={() => {
                  setStopped(null);
                  setStartedAt(null);
                  setElapsed(0);
                }}
              >
                Redo
              </Button>
            </div>
          ) : running ? (
            <Button
              size="xl"
              variant="danger"
              full
              className="min-h-32 text-4xl"
              onClick={() => {
                const at = Date.now();
                setStopped({ ms: at - (startedAt ?? at), at });
              }}
            >
              STOP
            </Button>
          ) : (
            <Button
              size="xl"
              variant="success"
              full
              className="min-h-32 text-4xl"
              onClick={() => {
                setStartedAt(Date.now());
                setElapsed(0);
              }}
            >
              START
            </Button>
          )}
        </div>
      </div>

      {picking && (
        <SwimmerPicker
          athletes={athletes}
          inEvent={inEvent}
          current={swimmer}
          ownTeam={ownTeam}
          meetTeams={snapshot.meet.teams}
          eventGender={stop.event.gender === "M" ? "M" : "F"}
          onPick={(athlete) => {
            setOverrides((current) => ({ ...current, [laneKey]: athlete.id }));
            setPicking(false);
          }}
          onAdd={(athlete) => {
            setAdded((current) => [...current, athlete]);
            setOverrides((current) => ({ ...current, [laneKey]: athlete.id }));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </main>
  );
}

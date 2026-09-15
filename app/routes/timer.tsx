import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/timer";
import { Button } from "~/components/ui";
import { SwimmerPicker } from "~/components/SwimmerPicker";
import { formatClock, formatTime } from "~/lib/time";
import {
  earliestAllowed,
  fetchSnapshot,
  loadFurthest,
  runningOrder,
  saveFurthest,
  type QueuedAthlete,
  type Snapshot,
  type TimerAthlete,
} from "~/lib/timer";
import { stopPath } from "~/lib/timer-path";
import { eventName } from "~/types/meet";
import {
  clearOverflow,
  enqueueSeat,
  enqueueStart,
  enqueueStop,
  enqueueSubmit,
  flushQueue,
  queueState,
} from "~/lib/timer-queue";
import type { LaneRef } from "~/lib/timer-messages";

/**
 * How often this phone asks what changed. Short, because the thing it's
 * watching for — a name corrected behind the blocks — matters in the minute
 * before a race and not at all afterwards.
 */
const SNAPSHOT_POLL_MS = 3000;

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
export default function Timer({ params }: Route.ComponentProps) {
  const navigate = useNavigate();

  /**
   * Everything about where this timer is standing comes from the URL.
   *
   * There is no "current heat" in state to drift from the address bar, no
   * lane remembered on the device, and nothing to restore on reload. The page
   * *is* the position.
   */
  const meetId = params.meetId;
  const timerId = params.timerId;
  const lane = Number(params.lane);
  const eventNo = Number(params.event);
  const heatNo = Number(params.heat);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [furthest, setFurthest] = useState(-1);
  const [picking, setPicking] = useState(false);
  /**
   * Set when somebody deliberately re-arms a heat they've already sent.
   *
   * Going back to a submitted heat shows that it's done rather than a green
   * START, but correcting the time you just took is exactly what going back
   * is *for* — `earliestAllowed` lets you reach one heat behind the last
   * submission precisely so you can. So the way through is there, one
   * deliberate tap away, rather than absent. Lives in state, so it lasts until
   * this screen is left.
   */
  const [retiming, setRetiming] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [stuck, setStuck] = useState(false);

  /**
   * What this phone still owes, and whether it has stopped being a blip.
   *
   * A count is normal — a message sits in a cookie for a second on a good
   * connection and a minute on a bad one. `overflow` is not: it means a
   * message could not be *stored*, because the browser's cookie limits were
   * reached, and no amount of waiting fixes that. Only that second one earns
   * a colour, because a timer glancing down mid-heat should see nothing
   * unless something is genuinely wrong.
   */
  const refreshQueue = () => {
    const state = queueState();
    setWaiting(state.pending.length);
    setStuck(state.overflow);
  };

  // Who this timer says is in the lane, per heat, before it's been submitted.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Swimmers typed in on this device; they may not have reached the server yet.
  // `QueuedAthlete`, not `Athlete`: each carries the team the timer tapped, and
  // that has to survive into the outbox for the server to enrol them.
  const [added, setAdded] = useState<QueuedAthlete[]>([]);

  /* --------------------------------------------------------------- loading */

  const load = useCallback(async () => {
    try {
      // Whether this phone is holding a code at all is the server's answer,
      // not a guess from storage — the token is in an HttpOnly cookie and
      // nothing here can see it. A phone without one gets a 401 and the
      // message that goes with it.
      setSnapshot(await fetchSnapshot(timerId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the meet.");
    }
  }, [timerId]);

  useEffect(() => {
    setFurthest(loadFurthest(meetId, timerId));
    refreshQueue();
    void load();
  }, [load, meetId, timerId]);

  // Anything stuck in the outbox goes out when the signal comes back, and when
  // the phone is picked up again. Neither is guaranteed to happen, which is why
  // submitting also flushes.
  useEffect(() => {
    const drain = () => {
      if (!meetId) return;
      void flushQueue(meetId, timerId).then(refreshQueue);
    };
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", drain);
    const timer = setInterval(drain, 20_000);
    return () => {
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", drain);
      clearInterval(timer);
    };
  }, [meetId, timerId]);

  /**
   * Pick up what everyone else has changed.
   *
   * This screen used to read the meet once, on opening, and never again — so a
   * lane reassigned at the desk, or a swimmer another timer corrected, simply
   * never appeared. On a deck that means timing the wrong person with no way
   * to find out.
   *
   * Only while the phone is being looked at: a pocketed screen has nobody
   * reading it, and its timers get throttled to uselessness anyway.
   */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void load();
    };
    const timer = setInterval(refresh, SNAPSHOT_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  /* ------------------------------------------------------------- stopwatch */

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopped, setStopped] = useState<{ ms: number; at: number } | null>(
    null,
  );
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
  /**
   * The heat this page is about, found by the numbering in its own URL.
   *
   * Undefined when the address names a heat this meet doesn't have — a stale
   * link, or a reseed that removed it — which the render below turns into
   * something readable rather than a blank screen.
   */
  const stopIndex = order.findIndex(
    (s) => s.event.position === eventNo - 1 && s.heat.index === heatNo - 1,
  );
  const stop = stopIndex >= 0 ? order[stopIndex] : undefined;

  const floor = earliestAllowed(furthest);

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

  /**
   * Where this screen is, as the meet numbers it — event 7, heat 1, lane 3.
   * The same three integers the cookie path is built from, so what the phone
   * queues and what the person is looking at cannot disagree.
   */
  const where: LaneRef | null =
    stop && lane
      ? { event: stop.event.position + 1, heat: stop.heat.index + 1, lane }
      : null;
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

  /**
   * Move to another heat by going to its page.
   *
   * The clock isn't carried across and doesn't need clearing: a different heat
   * is a different URL, so this screen remounts and the stopwatch starts from
   * nothing. Which is the honest behaviour anyway — a running clock belongs to
   * the race it was started for.
   */
  const move = (to: number) => {
    const target = order[Math.max(floor, Math.min(order.length - 1, to))];
    if (target) navigate(stopPath(meetId, timerId, target, lane));
  };

  /**
   * Say who's in this lane, straight away.
   *
   * Queued rather than posted directly so it behaves like a time does: if
   * there's no signal it waits, and it goes up with everything else when there
   * is. A swimmer typed in here travels with it, because the name and the
   * person have to reach the server together or not at all.
   */
  const claimLane = (athleteId: string, newcomer?: QueuedAthlete) => {
    if (!where || !meetId) return;

    // A swimmer picked from the list travels as an id. One typed in here
    // travels as a name and the team the timer tapped — by its place in this
    // meet's own list, because a timer may say "that's a Horizon swimmer",
    // not which team document to write into. The person is minted on the
    // server, which is the only side that can tell a new name from a name it
    // already has.
    const teamIndex = newcomer?.teamId
      ? Math.max(
          0,
          snapshot?.meet.teams.findIndex((t) => t.id === newcomer.teamId) ?? 0,
        )
      : 0;

    enqueueSeat(meetId, timerId, where, {
      team: teamIndex,
      ...(newcomer
        ? { name: `${newcomer.firstName} ${newcomer.lastName}`.trim() }
        : { athleteId }),
    });

    refreshQueue();
    void flushQueue(meetId, timerId).then(() => {
      refreshQueue();
      // Straight back for the corrected lineup, so the name on screen is the
      // one everybody else is now looking at.
      void load();
    });
  };

  const submit = async () => {
    if (!where || !meetId || !stopped) return;

    // The time, and only the time. Whether the built-in stopwatch was used is
    // something the server works out from whether a start and a stop came
    // through for this lane — it doesn't have to be asserted here, and a
    // phone that was offline through the race still submits the same message.
    enqueueSubmit(meetId, timerId, where, stopped.ms);

    // How far this device has got. The only thing about a timer's progress
    // that is still device state — the URL says where they *are*, not the
    // furthest they have been, and going back past a submitted heat is what
    // this exists to prevent.
    const reached = Math.max(furthest, stopIndex);
    setFurthest(reached);
    saveFurthest(meetId, timerId, reached);

    // Clear the clock before moving. Usually the next heat is a different URL
    // and this screen remounts anyway — but on the last heat of the meet there
    // is nowhere further to go, the URL doesn't change, nothing remounts, and
    // without this the time just submitted stays on screen above a Submit
    // button offering to send it again.
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
    setRetiming(false);

    // On to the next heat, which is the next page.
    const next = order[Math.min(order.length - 1, stopIndex + 1)];
    if (next) navigate(stopPath(meetId, timerId, next, lane));

    // A failure here is not worth reporting: the time is already in a cookie
    // addressed to the lane it belongs to, the header says how many are
    // waiting, and the next attempt is twenty seconds away. What matters is
    // that the screen has already moved on to the next heat.
    await flushQueue(meetId, timerId);
    refreshQueue();
  };

  /* ---------------------------------------------------------------- render */

  if (error && !snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-bold">Not timing yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {error}
          </p>
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
          disabled={running || stopIndex <= floor}
          onClick={() => move(stopIndex - 1)}
          aria-label="Previous heat"
        >
          ‹
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-bold">{eventName(stop.event)}</p>
          <p
            className={`text-xs ${
              stuck ? "font-bold text-red-600" : "text-slate-500"
            }`}
          >
            Heat {stop.number} of {stop.of}
            {stuck
              ? " · not saving — find signal"
              : waiting > 0 && ` · ${waiting} to send`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={running || stopIndex >= order.length - 1}
          onClick={() => move(stopIndex + 1)}
          aria-label="Next heat"
        >
          ›
        </Button>
      </header>

      <div className="flex flex-1 flex-col justify-between p-4">
        <div className="space-y-3">
          {/* Back to the lane picker, which is a page rather than a state —
              so this is a link, and the browser's own back button does the
              same thing. A timer swapping ends of the pool mid-meet is the
              case it exists for. */}
          <Link
            to={`/meets/${meetId}/timers/${timerId}`}
            className={`flex w-full touch-manipulation items-center justify-between rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900 ${
              running ? "pointer-events-none opacity-60" : ""
            }`}
          >
            <span className="text-3xl font-bold">Lane {lane}</span>
            <span className="text-sm font-semibold text-blue-600">change</span>
          </Link>

          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex w-full touch-manipulation items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900"
          >
            <span className="min-w-0">
              <span className="block truncate text-2xl font-bold">
                {swimmer
                  ? `${swimmer.firstName} ${swimmer.lastName}`.trim()
                  : "Empty lane"}
              </span>
              <span className="block truncate text-sm text-slate-500">
                {swimmer ? (swimmer.team ?? ownTeam) : "Tap to say who's here"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-blue-600">
              change
            </span>
          </button>
        </div>

        <div className="py-6 text-center">
          <p className="font-mono text-6xl font-bold tabular-nums">
            {stopped ? formatTime(stopped.ms) : formatClock(elapsed)}
          </p>
          {alreadyTimed && !stopped && startedAt === null && (
            <p className="mt-2 text-sm text-slate-500">
              Sent {formatTime(alreadyTimed.timeMs)} for this heat.
              {retiming && " Timing again replaces it."}
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
          ) : alreadyTimed && !retiming ? (
            /* This heat is done, and says so where the button would be.
               A green START here invites re-timing a heat whose sheet has
               already gone to the desk — and reads identically to the heat in
               front of you, which is the one that matters. */
            <>
              <Button
                size="xl"
                variant="success"
                full
                disabled
                className="min-h-32 text-4xl"
              >
                Submitted
              </Button>
              <Button variant="ghost" full onClick={() => setRetiming(true)}>
                Time it again
              </Button>
            </>
          ) : running ? (
            <Button
              size="xl"
              variant="danger"
              full
              className="min-h-32 text-4xl"
              onClick={() => {
                const at = Date.now();
                setStopped({ ms: at - (startedAt ?? at), at });
                // Queued, not sent: the thumb has more to do and the race
                // isn't over for everyone. It goes up with the submit.
                if (where && meetId) enqueueStop(meetId, timerId, where, at);
                refreshQueue();
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
                const at = Date.now();
                setStartedAt(at);
                setElapsed(0);
                // Sent on its own, straight away, because this is the one
                // message whose value is entirely in arriving early: the desk
                // wants to see five lanes armed and a sixth not *before* the
                // gun, which is the only moment anything can be done about it.
                if (where && meetId) {
                  enqueueStart(meetId, timerId, where, at);
                  void flushQueue(meetId, timerId).then(refreshQueue);
                }
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
            claimLane(athlete.id);
            setPicking(false);
          }}
          onAdd={(athlete) => {
            setAdded((current) => [...current, athlete]);
            setOverrides((current) => ({ ...current, [laneKey]: athlete.id }));
            claimLane(athlete.id, athlete);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </main>
  );
}

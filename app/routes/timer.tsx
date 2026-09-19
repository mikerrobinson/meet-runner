import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/timer";
import { Button } from "~/components/ui";
import { SwimmerPicker } from "~/components/SwimmerPicker";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import {
  earliestAllowed,
  fetchSnapshot,
  loadFurthest,
  loadRole,
  runningOrder,
  saveFurthest,
  watchCount,
  type QueuedAthlete,
  type Snapshot,
  type TimerAthlete,
  type TimerRole,
} from "~/lib/timer";
import { watchSlot } from "~/lib/timing";
import { stopPath, timerPath } from "~/lib/timer-path";
import { eventName } from "~/types/meet";
import {
  enqueueExhibition,
  enqueueSeat,
  enqueueStart,
  enqueueStop,
  enqueueSubmit,
  flushQueue,
  queueState,
} from "~/lib/timer-queue";
import type { LaneRef } from "~/lib/timer-messages";
import { useMeetChanges } from "~/hooks/use-meet-changes";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Swim Starts" }];
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
 *
 * At a meet whose lanes carry two or three watches, a phone that said it has
 * the sheet gets the other screen: no stopwatch of its own, a column per
 * timer standing behind the lane, and one submit that files all of them. It
 * is the same page otherwise — same lane, same swimmer, same queue, same walk
 * through the heats — because it is the same job done the way a deck actually
 * does it, with the handheld watches doing the timing and this holding what
 * they read.
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
  const [refused, setRefused] = useState<string | null>(null);

  /**
   * What this phone still owes, and whether it has stopped being a blip.
   *
   * A count is normal — a message sits in a cookie for a second on a good
   * connection and a minute on a bad one. `overflow` is not: it means a
   * message could not be *stored*, because the browser's cookie limits were
   * reached, and no amount of waiting fixes that. Only that second one earns
   * a colour, because a timer glancing down mid-heat should see nothing
   * unless something is genuinely wrong.
   *
   * `rejected` is the other one that earns it: a message the server refused
   * outright is dropped rather than retried, so a time can be gone for good,
   * and the one person who can do anything about it is standing here.
   */
  const refreshQueue = () => {
    const state = queueState();
    setWaiting(state.pending.length);
    setStuck(state.overflow);
    setRefused(state.rejected);
  };

  /**
   * Whether this phone is a stopwatch or a sheet, as it answered at the lane
   * picker. `null` until the cookie has been read, which cannot happen on the
   * server — and reads as a clipboard once it has, for the same reason the
   * picker defaults that way.
   */
  const [role, setRole] = useState<TimerRole | null>(null);
  /**
   * What the clipboard has written down so far, as typed, one string per
   * column.
   *
   * Text rather than milliseconds because that is what is in front of the
   * person: half of "30.4" is not a time yet, and a field that reinterpreted
   * itself on every keystroke would fight the thumb entering it. Read through
   * `parseTime`, which is the same reader the desk uses, so "3045" and
   * "30.45" mean what they do everywhere else in the app.
   */
  const [sheet, setSheet] = useState<string[]>([]);

  // Who this timer says is in the lane, per heat, before it's been submitted.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Whether this timer says the lane's swim is exhibition, per heat, ahead of
  // the next snapshot poll catching up — same reason `overrides` exists.
  const [exhibitionOverrides, setExhibitionOverrides] = useState<
    Record<string, boolean>
  >({});
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
      setSnapshot(await fetchSnapshot());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the meet.");
    }
  }, []);

  useEffect(() => {
    setFurthest(loadFurthest());
    setRole(loadRole() ?? "clipboard");
    refreshQueue();
    void load();
  }, [load, meetId]);

  // Anything stuck in the outbox goes out when the signal comes back, and when
  // the phone is picked up again. Neither is guaranteed to happen, which is why
  // submitting also flushes.
  useEffect(() => {
    const drain = () => {
      if (!meetId) return;
      void flushQueue(meetId).then(refreshQueue);
    };
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", drain);
    const timer = setInterval(drain, 20_000);
    return () => {
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", drain);
      clearInterval(timer);
    };
  }, [meetId]);

  /**
   * Pick up what everyone else has changed.
   *
   * This screen used to read the meet once, on opening, and never again — so a
   * lane reassigned at the desk, or a swimmer another timer corrected, simply
   * never appeared. On a deck that means timing the wrong person with no way
   * to find out.
   *
   * Used to be a blind 10s poll; now it's the meet's own live connection
   * (migration-plan.md §3.4) — this phone doesn't keep the DO's snapshot
   * itself the way `useMeetLive` does for admin/splits, it just re-reads its
   * own purpose-built `fetchSnapshot` whenever the connection says something
   * happened, which is a much closer match for "a name corrected behind the
   * blocks" than a fixed interval ever was.
   *
   * Only while the phone is being looked at: a pocketed screen has nobody
   * reading it, and its timers get throttled to uselessness anyway. Coming
   * back to the tab refreshes immediately rather than waiting for the next
   * change, in case something happened while it was out of sight.
   */
  useMeetChanges(meetId, () => {
    if (document.visibilityState === "visible") void load();
  });
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
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

  /**
   * A clock belongs to the race it was started for.
   *
   * Moving to another heat changes this route's params rather than matching a
   * different route, so React keeps the component and everything above would
   * otherwise follow the timer down the pool. It did: STOP, then ›, and heat 2
   * opened showing heat 1's time above a live Submit that would have filed it
   * against the new lane.
   */
  useEffect(() => {
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
    setRetiming(false);
    setPicking(false);
    // Three times written down for heat 1 are not heat 2's times, for the
    // same reason the clock above isn't heat 2's clock.
    setSheet([]);
    // Same route, new params — the browser has no page load to reset scroll
    // on, so a heat scrolled down to reach Submit would otherwise open the
    // next one already scrolled.
    window.scrollTo(0, 0);
  }, [eventNo, heatNo, lane]);

  /* ----------------------------------------------------------------- state */

  const order = useMemo(
    () => (snapshot ? runningOrder(snapshot.events, snapshot.seeds) : []),
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
    (s) => s.event.position === eventNo - 1 && s.heat === heatNo,
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
   * How many columns this phone is filling in — one for a stopwatch, one per
   * timer behind the lane for a sheet.
   *
   * The only thing that decides which screen this is. Everything downstream
   * reads the number rather than the role, so a clipboard at a meet that has
   * gone back to one watch a lane is simply a stopwatch again.
   */
  const watches = watchCount(snapshot, role);
  const clipboard = watches > 1;

  /**
   * Where this screen is, as the meet numbers it — event 7, heat 1, lane 3.
   * The same three integers the cookie path is built from, so what the phone
   * queues and what the person is looking at cannot disagree.
   */
  const where: LaneRef | null =
    stop && lane
      ? { event: stop.event.position + 1, heat: stop.heat, lane }
      : null;

  /** The swim in this lane, if anybody has said who is in it. */
  const seed = stop?.seeds.find((s) => s.lane === lane);
  const laneKey = stop && lane ? `${stop.event.id}/${stop.heat}/${lane}` : "";
  const swimmerId = overrides[laneKey] ?? seed?.athleteId ?? null;
  const swimmer = swimmerId ? byId.get(swimmerId) : undefined;
  const exhibition = exhibitionOverrides[laneKey] ?? seed?.exhibition ?? false;

  /**
   * This phone's own times for this swim, once the server has them, by column.
   *
   * A watch with no time on it is a stopwatch running — this phone's own, or
   * one of the handheld ones it armed — and is not a time sent. A column that
   * never got one stays empty, which is exactly what the screen has to show
   * when two of three timers came back with something.
   */
  const sent = useMemo(() => {
    const times: Array<number | null> = Array.from(
      { length: watches },
      () => null,
    );
    if (!snapshot || !seed) return times;
    for (const watch of snapshot.mine) {
      if (watch.seedId !== seed.id || watch.timeMs === undefined) continue;
      const slot = watchSlot(watch.timerId);
      if (slot <= watches) times[slot - 1] = watch.timeMs;
    }
    return times;
  }, [snapshot, seed, watches]);

  const alreadyTimed = sent.some((ms) => ms !== null);
  const sentLabel = sent
    .filter((ms): ms is number => ms !== null)
    .map(formatTime)
    .join(", ");

  /* --------------------------------------------------------------- actions */

  /**
   * Move to another heat by going to its page.
   *
   * The clock is cleared on the way, by the effect above rather than here, so
   * that every arrival at a heat behaves the same whether it came from these
   * arrows, from Submit, or from the back button.
   */
  const move = (to: number) => {
    const target = order[Math.max(floor, Math.min(order.length - 1, to))];
    if (target) navigate(stopPath(meetId, target, lane));
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

    enqueueSeat(meetId, where, {
      team: teamIndex,
      ...(newcomer
        ? { name: `${newcomer.firstName} ${newcomer.lastName}`.trim() }
        : { athleteId }),
    });

    refreshQueue();
    void flushQueue(meetId).then(() => {
      refreshQueue();
      // Straight back for the corrected lineup, so the name on screen is the
      // one everybody else is now looking at.
      void load();
    });
  };

  /**
   * Say whether this lane's swim counts, straight away — the same way a seat
   * goes up, because it's a fact about the swim rather than evidence to
   * reconcile with anyone else's later.
   */
  const toggleExhibition = () => {
    if (!where || !meetId) return;
    const next = !exhibition;
    setExhibitionOverrides((current) => ({ ...current, [laneKey]: next }));
    enqueueExhibition(meetId, where, next);
    refreshQueue();
    void flushQueue(meetId).then(refreshQueue);
  };

  /**
   * Arm the lane.
   *
   * Sent on its own, straight away, because this is the one message whose
   * value is entirely in arriving early: the desk wants to see five lanes
   * armed and a sixth not *before* the gun, which is the only moment anything
   * can be done about it.
   *
   * A clipboard arms every watch behind its lane rather than one, since that
   * is how many clocks just started — and the desk, which is watching for a
   * lane nobody is covering, should see three.
   */
  const arm = () => {
    const at = Date.now();
    setStartedAt(at);
    setElapsed(0);
    if (where && meetId) {
      enqueueStart(meetId, where, at, watches);
      void flushQueue(meetId).then(refreshQueue);
    }
  };

  /**
   * File this lane's times and move on.
   *
   * Takes the whole sheet, one entry per watch and `null` where a watch has
   * nothing, because that is what the lane is saying: not "here is a time"
   * but "here is what the watches on this lane read". One phone with one
   * stopwatch says the same thing with one column.
   */
  const submit = async (times: Array<number | null>) => {
    if (!where || !meetId || !times.some((ms) => ms !== null)) return;

    // The times, and only the times. Whether a built-in stopwatch was used is
    // something the server works out from whether a start and a stop came
    // through for this lane — it doesn't have to be asserted here, and a
    // phone that was offline through the race still submits the same message.
    enqueueSubmit(meetId, where, times);

    // How far this device has got. The only thing about a timer's progress
    // that is still device state — the URL says where they *are*, not the
    // furthest they have been, and going back past a submitted heat is what
    // this exists to prevent.
    const reached = Math.max(furthest, stopIndex);
    setFurthest(reached);
    saveFurthest(meetId, reached);

    // Clear the clock before moving. Usually the navigation below does it, by
    // changing the heat in the URL — but on the last heat of the meet there is
    // nowhere further to go, nothing in the address changes, and without this
    // the time just submitted stays on screen above a Submit button offering
    // to send it again.
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
    setRetiming(false);
    setSheet([]);

    // On to the next heat, which is the next page.
    const next = order[Math.min(order.length - 1, stopIndex + 1)];
    if (next) navigate(stopPath(meetId, next, lane));

    // A failure here is not worth reporting: the time is already in a cookie
    // addressed to the lane it belongs to, the header says how many are
    // waiting, and the next attempt is twenty seconds away. What matters is
    // that the screen has already moved on to the next heat.
    await flushQueue(meetId);
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
  /**
   * Whether walking away from this heat is currently refused.
   *
   * A stopwatch mid-race is: the arrows and the lane link would abandon a
   * clock that is the only record of a swim in progress. A clipboard's isn't
   * — nothing is being measured here, the watches are in other people's
   * hands, and there is no stop button coming that would ever unlock it.
   */
  const locked = running && !clipboard;
  const inEvent = new Set(snapshot.entries[stop.event.id] ?? []);

  /**
   * The one line that is allowed to be red.
   *
   * Both of these mean a time is not coming back on its own, which is the only
   * thing worth interrupting somebody mid-heat for. A queue that is merely
   * waiting says so in grey and is none of their business.
   */
  const alarm = stuck ? "not saving — find signal" : refused;

  return (
    <main className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Where we are. Small: it's context, not the job. */}
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] dark:border-slate-800 dark:bg-slate-900">
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || stopIndex <= floor}
          onClick={() => move(stopIndex - 1)}
          aria-label="Previous heat"
        >
          ‹
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-bold">{eventName(stop.event)}</p>
          <p
            className={`text-xs ${
              alarm ? "font-bold text-red-600" : "text-slate-500"
            }`}
          >
            Heat {stop.number} of {stop.of}
            {alarm ? ` · ${alarm}` : waiting > 0 && ` · ${waiting} to send`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || stopIndex >= order.length - 1}
          onClick={() => move(stopIndex + 1)}
          aria-label="Next heat"
        >
          ›
        </Button>
      </header>

      <div
        className={`flex flex-1 flex-col p-4 ${
          clipboard ? "gap-3" : "justify-between"
        }`}
      >
        <div className="space-y-3">
          {/* Back to the lane picker, which is a page rather than a state —
              so this is a link, and the browser's own back button does the
              same thing. A timer swapping ends of the pool mid-meet is the
              case it exists for. */}
          <Link
            to={timerPath(meetId)}
            className={`flex w-full touch-manipulation items-center justify-between rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900 ${
              locked ? "pointer-events-none opacity-60" : ""
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

          {/* Doesn't need a name or a time to be true, so it's here rather
              than buried in the sheet below — a call a timer can make about
              the lane before the race is even swum. */}
          <button
            type="button"
            onClick={toggleExhibition}
            aria-pressed={exhibition}
            className={`flex w-full touch-manipulation items-center justify-between rounded-2xl px-4 py-3 text-left ${
              exhibition
                ? "bg-amber-500 text-white"
                : "bg-white dark:bg-slate-900"
            }`}
          >
            <span className="font-semibold">Exhibition</span>
            <span className={`text-sm ${exhibition ? "" : "text-slate-500"}`}>
              {exhibition ? "Won't score or place" : "Time counts, but not for scoring"}
            </span>
          </button>
        </div>

        {clipboard ? (
          <ClipboardSheet
            watches={watches}
            values={sheet}
            onChange={(column, value) =>
              setSheet((current) => {
                const next = [...current];
                next[column] = value;
                return next;
              })
            }
            sent={sent}
            retiming={retiming}
            onRetime={() => {
              // Whatever went up is what a correction starts from — the point
              // of coming back is usually one column, not all three.
              setSheet(sent.map((ms) => (ms === null ? "" : formatTime(ms))));
              setRetiming(true);
            }}
            onSubmit={(times) => void submit(times)}
          />
        ) : (
          <>
            <div className="py-6 text-center">
              <p className="font-mono text-6xl font-bold tabular-nums">
                {stopped ? formatTime(stopped.ms) : formatClock(elapsed)}
              </p>
              {alreadyTimed && !stopped && startedAt === null && (
                <p className="mt-2 text-sm text-slate-500">
                  Sent {sentLabel} for this heat.
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
                    onClick={() => void submit([stopped.ms])}
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
                  <Button
                    variant="ghost"
                    full
                    onClick={() => setRetiming(true)}
                  >
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
                    // Sent straight away, like the start: the desk should see
                    // this lane has stopped (and stop counting it as running)
                    // well before this thumb gets around to submitting a
                    // final sheet — the fetch is fire-and-forget, so it
                    // doesn't hold up whatever this thumb does next.
                    if (where && meetId) {
                      enqueueStop(meetId, where, at);
                      void flushQueue(meetId).then(refreshQueue);
                    } else {
                      refreshQueue();
                    }
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
                  onClick={arm}
                >
                  START
                </Button>
              )}
            </div>
          </>
        )}
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

/**
 * The lane's sheet: a column per watch, and one submit for all of them.
 *
 * What a timing lane looks like on a deck. Two or three people hold handheld
 * stopwatches, one person holds a clipboard, and when the race ends the
 * watches are read out and written down. Nothing here measures anything — the
 * clock above the columns is the race's, for reassurance and for anyone
 * checking a reading that looks wrong, and it is deliberately grey and small
 * so that nobody mistakes it for a time to copy.
 *
 * Empty columns are allowed and mean what they say: a timer who missed the
 * start has nothing, and the swim is still timed by the other two. A column
 * is never shuffled up to fill a gap — watch 2's time is watch 2's whether or
 * not watch 1 has one, and the server files it that way.
 *
 * Unreadable text is the one thing that blocks the submit. Everything else
 * this screen can interpret it does, out loud, in the column beside the entry,
 * so "3045" showing as 30.45 is never a surprise sprung after the fact.
 */
function ClipboardSheet({
  watches,
  values,
  onChange,
  sent,
  retiming,
  onRetime,
  onSubmit,
}: {
  watches: number;
  /** What has been typed, by column. Sparse until somebody types. */
  values: string[];
  onChange: (column: number, value: string) => void;
  /** What this phone has already filed for this swim, by column. */
  sent: Array<number | null>;
  retiming: boolean;
  onRetime: () => void;
  onSubmit: (times: Array<number | null>) => void;
}) {
  const columns = Array.from({ length: watches }, (_, index) => index);
  const typed = columns.map((column) => (values[column] ?? "").trim());
  const parsed = typed.map((text) => (text ? parseTime(text) : null));

  const done = sent.some((ms) => ms !== null) && !retiming;
  const unreadable = typed.some((text, i) => text !== "" && parsed[i] === null);
  const count = parsed.filter((ms) => ms !== null).length;

  return (
    <div className="space-y-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {columns.map((column) => (
        <label
          key={column}
          className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-slate-900"
        >
          <span className="w-20 shrink-0 text-sm font-bold text-slate-500">
            Watch {column + 1}
          </span>
          {done ? (
            <span className="min-w-0 flex-1 text-right font-mono text-3xl font-bold tabular-nums">
              {sent[column] === null ? "\u2014" : formatTime(sent[column]!)}
            </span>
          ) : (
            <input
              // Shown formatted — "3045" reads back as "30.45" while the
              // thumb is still typing it, so the separators never have to be
              // typed and a misread digit shows up immediately rather than
              // waiting for a preview off to the side.
              value={
                typed[column] === ""
                  ? ""
                  : parsed[column] !== null
                    ? formatTime(parsed[column]!)
                    : typed[column]
              }
              onChange={(event) =>
                onChange(
                  column,
                  event.target.value.replace(/\D/g, "").slice(0, 7),
                )
              }
              inputMode="numeric"
              placeholder={"\u2014"}
              aria-label={`Watch ${column + 1}`}
              className="min-w-0 flex-1 rounded-xl border-2 border-slate-300 bg-slate-50 px-3 py-2.5 text-right font-mono text-4xl font-bold tabular-nums outline-none focus:border-blue-500 placeholder:text-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:placeholder:text-slate-600"
            />
          )}
        </label>
      ))}

      {/* Nothing to explain about a sheet that has already gone up. */}
      {!done && (
        <p
          className={`px-1 text-xs ${
            unreadable ? "font-bold text-red-600" : "text-slate-500"
          }`}
        >
          {unreadable
            ? "One of those can\u2019t be read as a time. 3045 is 30.45."
            : "Just digits \u2014 3045 is 30.45, 11127 is 1:11.27."}
        </p>
      )}

      {done ? (
        /* Already gone to the desk, and says so where the button would be \u2014
           a live Submit here invites sending a sheet that has already been
           read out. Coming back to fix one column is exactly what the ghost
           button under it is for. */
        <>
          <Button
            size="xl"
            variant="success"
            full
            disabled
            className="min-h-24 text-3xl"
          >
            Submitted
          </Button>
          <Button variant="ghost" full onClick={onRetime}>
            Change these times
          </Button>
        </>
      ) : (
        <Button
          size="xl"
          variant="success"
          full
          className="min-h-24 text-3xl"
          disabled={unreadable || count === 0}
          onClick={() => onSubmit(parsed)}
        >
          Submit
        </Button>
      )}
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The deck stopwatch, and the one place it exists.
 *
 * It used to be `meet.timer`, a field inside the meet document — which meant
 * it synced. One coach tapping START reached into every other device's copy of
 * the meet, and because starting a heat also cleared that heat's times, it
 * reached in and deleted watches the timing phones had already sent. The
 * timers' own screens never read it, so the one shared thing was not shared
 * with the people who needed it.
 *
 * A stopwatch is a fact about the device holding it. Three timers behind one
 * lane each start their own on the strobe; nobody's clock is anybody else's.
 * So this is React state, it never reaches IndexedDB, and it never reaches the
 * wire.
 *
 * It's a context rather than component state only because the header needs to
 * know: rearranging the stop buttons under a running clock is how a lane gets
 * missed, so the layout toggle is held still while a heat is on the clock.
 */
export interface RunClock {
  /** The heat being timed on this device, and when it started. */
  clock: {
    heatId: string;
    startedAt: number;
    /**
     * Lanes that already had a time when this run started.
     *
     * The screen is finished when nothing is left for it to time, and a lane
     * somebody else stops during the race counts. A lane carrying a time from
     * *before* the start does not: a heat being swum again has stale times all
     * over it, and letting those count meant pressing START on a re-swim
     * declared the heat over before anyone left the blocks.
     *
     * A set of lanes rather than a timestamp, because the alternative is
     * comparing one device's clock against another's and hoping.
     */
    alreadyTimed: number[];
  } | null;
  start: (heatId: string, alreadyTimed: number[]) => void;
  stop: () => void;
}

const RunClockContext = createContext<RunClock | null>(null);

export function RunClockProvider({ children }: { children: ReactNode }) {
  const [clock, setClock] = useState<RunClock["clock"]>(null);

  const start = useCallback((heatId: string, alreadyTimed: number[]) => {
    setClock({ heatId, startedAt: Date.now(), alreadyTimed });
  }, []);
  const stop = useCallback(() => setClock(null), []);

  const value = useMemo<RunClock>(
    () => ({ clock, start, stop }),
    [clock, start, stop],
  );

  return (
    <RunClockContext.Provider value={value}>{children}</RunClockContext.Provider>
  );
}

export function useRunClock(): RunClock {
  const value = useContext(RunClockContext);
  if (!value) throw new Error("useRunClock used outside RunClockProvider");
  return value;
}

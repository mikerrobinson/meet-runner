import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { loadAutoSync, saveAutoSync } from "~/lib/storage";
import { readBaseline, readCursor, writeBaseline, writeCursor } from "~/lib/db";
import {
  changedObjects,
  fromObjects,
  mergeObjects,
  toObjects,
  type SyncObject,
} from "~/lib/objects";
import { SyncRequestError, exchange, syncStatus } from "~/lib/sync";
import { useAppStore } from "~/state/app-store";
import type { MeetDoc, TeamDoc } from "~/types/meet";

/**
 * Pushes the meet to the server on its own, shortly after things go quiet.
 *
 * Everything here is deliberately off the render path: the work is scheduled on
 * a timer, the document is read from a ref at fire time rather than captured in
 * a closure, and React state is only touched when the *phase* changes — a few
 * times a minute — never per keystroke or per lane tapped.
 *
 * Push only. Pulling would mean the server could overwrite deck work behind
 * the coach's back, so that stays a deliberate button.
 */

export type SyncPhase =
  | "idle"
  | "syncing"
  | "error"
  /**
   * The server holds a newer copy of something this device is trying to push,
   * so the push was refused. Retrying can't help — the two copies have to be
   * reconciled by hand.
   */
  | "diverged"
  /** Server has no database bound, or the token is wrong. Stop trying. */
  | "unavailable";

export interface SyncStatus {
  phase: SyncPhase;
  /** How many documents are waiting to go up. */
  pendingCount: number;
  /** Device preference: does this device push on its own? */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  message?: string;
  /** When a push last succeeded, for the "just now" line. */
  lastSyncAt: number | null;
  /** True when local edits haven't reached the server yet. */
  pending: boolean;
  /** Push right now, ignoring the debounce. */
  syncNow: () => void;
}

/**
 * Whether a team is worth putting on the server yet.
 *
 * A team with nobody on it and no meets is a placeholder a device made for
 * itself before it knew any better. Pushing one is how an empty roster once
 * came to shadow a real season — so it stays put until it has something in
 * it, and adopting the real team quietly replaces it.
 */
function hasSomethingToSay(team: TeamDoc, meets: MeetDoc[]): boolean {
  return team.swimmers.length > 0 || meets.length > 0;
}

/** Quiet period before a push. Long enough to swallow a burst of lane taps. */
const DEBOUNCE_MS = 2500;
/**
 * How often a visible device asks what happened elsewhere.
 *
 * Without this, news only arrives when the device has something of its own to
 * send or the tab regains focus — so a coach watching the registration grid
 * while someone else fills it in would sit there looking at a stale screen.
 * Ten seconds is short enough to feel live on a deck and long enough that an
 * idle tab costs almost nothing: an empty exchange is about 130 bytes.
 */
const POLL_MS = 10_000;
/** Backoff after failures — a dead pool wifi shouldn't be retried every second. */
const BACKOFF_MS = [4000, 10_000, 30_000, 60_000];

const SyncStatusContext = createContext<SyncStatus | null>(null);

export function AutoSyncProvider({ children }: { children: ReactNode }) {
  const {
    ready,
    team,
    meets,
    deletedMeets,
    applyFromSync,
  } = useAppStore();
  // Tombstones are the whole point of the delete: they have to go up too.
  const syncable = useMemo(
    () => [...meets, ...deletedMeets],
    [meets, deletedMeets],
  );

  const [phase, setPhase] = useState<SyncPhase>("idle");
  // Defaults on; the stored preference is read once the client mounts.
  const [enabled, setEnabledState] = useState(true);
  const [message, setMessage] = useState<string | undefined>();
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  // Live handles to things the timer callback needs, so the scheduling effect
  // doesn't have to re-run (and reset the debounce) on every edit.
  // `ready` matters as much as the documents: before the store has read
  // storage, `team` is a throwaway placeholder, and pushing that would put an
  // empty roster on the server ahead of the real one.
  const docsRef = useRef({ ready, team, meets: syncable });
  docsRef.current = { ready, team, meets: syncable };
  const applyRef = useRef(applyFromSync);
  applyRef.current = applyFromSync;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  /**
   * What the server and this device last agreed on, as objects.
   *
   * Doubles as each object's real timestamp. The documents only have one
   * between them, which is too coarse to merge on: a swimmer added here and a
   * time recorded there have to be able to win independently.
   */
  const [baseline, setBaseline] = useState<SyncObject[]>([]);
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const cursorRef = useRef("");
  /** Set when we want the server's news even with nothing of our own to send. */
  const wantPullRef = useRef(true);
  /**
   * Until the stored baseline is read back, this device doesn't know what the
   * server already has — and would push the whole season as though it were
   * new. Nothing goes out before it lands.
   */
  const baselineLoadedRef = useRef(false);
  const [baselineLoaded, setBaselineLoaded] = useState(false);
  /** Which team the baseline describes, so switching seasons can't confuse it. */
  const baselineTeamRef = useRef<string | null>(null);

  const failuresRef = useRef(0);
  const stoppedRef = useRef(false);

  /**
   * What's waiting to go up, object by object.
   *
   * Compared against the baseline by content rather than by timestamp: the
   * documents carry one timestamp between them, so a single lane tap would
   * otherwise look like every time in the meet had changed.
   */
  const outgoing = useMemo(() => {
    if (!ready || !baselineLoaded || !hasSomethingToSay(team, syncable)) {
      return [];
    }
    return changedObjects(baseline, toObjects(team, syncable));
  }, [ready, baselineLoaded, team, syncable, baseline]);

  const pendingCount = outgoing.length;
  const pending = pendingCount > 0;
  // Identity of what's waiting, so an edit to something already pending still
  // wakes the scheduler — the count alone wouldn't change.
  const pendingSignature = outgoing
    .map((o) => `${o.type}:${o.id}:${o.updatedAt}`)
    .join("|");

  // Declared up front so `schedule` can reach the latest pump without the two
  // callbacks depending on each other.
  const pumpRef = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback((delay: number) => {
    if (stoppedRef.current || !enabledRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void pumpRef.current();
    }, delay);
  }, []);

  const pump = useCallback(async () => {
    if (stoppedRef.current || inFlightRef.current) return;

    const {
      ready: isReady,
      team: currentTeam,
      meets: currentMeets,
    } = docsRef.current;
    if (!isReady || !baselineLoadedRef.current) return;

    const base = baselineRef.current;
    const changes = hasSomethingToSay(currentTeam, currentMeets)
      ? changedObjects(base, toObjects(currentTeam, currentMeets))
      : [];

    // Nothing to send and nothing asked for: don't wake the server up.
    if (changes.length === 0 && !wantPullRef.current) return;

    inFlightRef.current = true;
    setPhase("syncing");

    try {
      const result = await exchange(
        currentTeam.id,
        cursorRef.current,
        changes,
      );
      wantPullRef.current = false;

      // What this device now believes, object by object: what it just sent,
      // then whatever came back on top — newest edit wins, per object.
      const sent = mergeObjects(base, changes);
      const merged = mergeObjects(sent, result.changes);

      // A refusal means the server's copy of that one object was edited more
      // recently. Take its version rather than insisting on ours.
      const settled =
        result.refused.length > 0
          ? mergeObjects(merged, result.refused)
          : merged;

      baselineRef.current = settled;
      cursorRef.current = result.cursor;
      setBaseline(settled);
      void writeBaseline(settled);
      void writeCursor(result.cursor);

      // Only rebuild the season when something actually arrived — recomposing
      // for nothing would churn every document on the screen.
      if (result.changes.length > 0 || result.refused.length > 0) {
        const { team: nextTeam, meets: nextMeets } = fromObjects(settled);
        if (nextTeam) applyRef.current(nextTeam, nextMeets);
      }

      failuresRef.current = 0;
      if (result.refused.length > 0) {
        // Not a stalemate any more: the objects we lost were superseded, and
        // we've just taken the newer versions. Worth saying, not worth
        // blocking on.
        setPhase("diverged");
        setMessage(
          `The server had newer versions of ${result.refused.length} thing${
            result.refused.length === 1 ? "" : "s"
          }; this device has taken them.`,
        );
      } else {
        setPhase("idle");
        setMessage(undefined);
      }
      setLastSyncAt(Date.now());

      // More pages waiting: keep going rather than waiting for an edit.
      if (result.more) {
        wantPullRef.current = true;
        schedule(0);
        return;
      }
    } catch (error) {
      const status = error instanceof SyncRequestError ? error.status : -1;
      // A missing database or a rejected token won't fix itself; retrying
      // would just burn battery on the deck.
      if (status === 503 || status === 401) {
        stoppedRef.current = true;
        setPhase("unavailable");
        setMessage(error instanceof Error ? error.message : undefined);
      } else {
        failuresRef.current += 1;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Sync failed");
      }
    } finally {
      inFlightRef.current = false;
    }

    const now = docsRef.current;
    if (stoppedRef.current || !now.ready) return;
    const stillPending =
      hasSomethingToSay(now.team, now.meets) &&
      changedObjects(baselineRef.current, toObjects(now.team, now.meets))
        .length > 0;
    if (stillPending) {
      const failures = failuresRef.current;
      schedule(
        failures === 0
          ? DEBOUNCE_MS
          : BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)],
      );
    }
  }, [schedule]);

  pumpRef.current = pump;

  // Runs before the scheduling effects below, so a device with auto-sync
  // switched off never gets one stray push in before the preference loads.
  useEffect(() => {
    const stored = loadAutoSync();
    enabledRef.current = stored;
    setEnabledState(stored);
    if (!stored && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Don't even start until the server says sync is configured.
  useEffect(() => {
    let cancelled = false;
    syncStatus().then((status) => {
      if (cancelled) return;
      if (!status.enabled) {
        stoppedRef.current = true;
        setPhase("unavailable");
        setMessage(status.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The debounce itself: every edit restarts the clock, so a burst of taps
  // produces one push rather than one per tap.
  useEffect(() => {
    if (!ready || !pending || !enabledRef.current) return;
    schedule(
      failuresRef.current === 0
        ? DEBOUNCE_MS
        : BACKOFF_MS[Math.min(failuresRef.current - 1, BACKOFF_MS.length - 1)],
    );
  }, [ready, pending, pendingSignature, schedule]);

  // Pick up where the last session left off before anything is sent, or the
  // first push would look like the whole season had just been written.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const [stored, cursor] = await Promise.all([readBaseline(), readCursor()]);
      if (cancelled) return;
      baselineRef.current = stored;
      cursorRef.current = cursor;
      baselineTeamRef.current = docsRef.current.team.id;
      baselineLoadedRef.current = true;
      setBaseline(stored);
      setBaselineLoaded(true);
    })().catch(() => {
      baselineLoadedRef.current = true;
      setBaselineLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  /**
   * Taking on a different season re-reads the baseline rather than assuming.
   *
   * The one in memory describes the team we *were* on: diffing the new season
   * against it would read every object of the old one as deleted. Adopting a
   * season writes a fresh baseline as it pulls, so the right move is to pick
   * that up — otherwise the device would push the whole season straight back
   * and be told, object by object, that the server already had it.
   */
  useEffect(() => {
    if (!baselineLoadedRef.current) return;
    if (baselineTeamRef.current === team.id) return;
    baselineTeamRef.current = team.id;

    let cancelled = false;
    (async () => {
      const [stored, cursor] = await Promise.all([readBaseline(), readCursor()]);
      if (cancelled) return;
      baselineRef.current = stored;
      cursorRef.current = cursor;
      wantPullRef.current = true;
      setBaseline(stored);
    })().catch(() => {
      baselineRef.current = [];
      cursorRef.current = "";
      setBaseline([]);
    });

    return () => {
      cancelled = true;
    };
  }, [team.id]);

  /**
   * Ask for news on a timer while the tab is visible.
   *
   * Stops the moment the tab is hidden — a backgrounded device has nobody
   * looking at it, and its timers get throttled to uselessness anyway.
   */
  useEffect(() => {
    if (!ready || !enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (stoppedRef.current || !enabledRef.current) return;
        wantPullRef.current = true;
        void pumpRef.current();
      }, POLL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, enabled]);

  // Coming back from a dead zone, or back to the tab, is the moment most
  // worth retrying — waiting out the backoff would be silly.
  useEffect(() => {
    const retry = () => {
      if (stoppedRef.current || !enabledRef.current) return;
      if (!docsRef.current.ready) return;
      failuresRef.current = 0;
      // Coming back to the tab is also the moment to find out what happened
      // elsewhere while it was in the background — not just to retry our own.
      wantPullRef.current = true;
      schedule(0);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [schedule]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      saveAutoSync(next);
      setEnabledState(next);
      enabledRef.current = next;
      if (next) {
        // Turning it back on should catch up straight away rather than
        // waiting out a debounce or a stale backoff.
        failuresRef.current = 0;
        schedule(0);
      } else if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [schedule],
  );

  const syncNow = useCallback(() => {
    // A manual sync is also a request for the server's news.
    wantPullRef.current = true;
    stoppedRef.current = false;
    failuresRef.current = 0;
    // A manual push works even with auto-sync switched off.
    const wasEnabled = enabledRef.current;
    enabledRef.current = true;
    schedule(0);
    enabledRef.current = wasEnabled;
  }, [schedule]);

  const value = useMemo<SyncStatus>(
    () => ({
      phase,
      pendingCount,
      enabled,
      setEnabled,
      message,
      lastSyncAt,
      pending,
      syncNow,
    }),
    [phase, pendingCount, enabled, setEnabled, message, lastSyncAt, pending, syncNow],
  );

  return (
    <SyncStatusContext.Provider value={value}>
      {children}
    </SyncStatusContext.Provider>
  );
}

export function useSyncStatus(): SyncStatus {
  const status = useContext(SyncStatusContext);
  if (!status) {
    throw new Error("useSyncStatus must be used inside an AutoSyncProvider");
  }
  return status;
}

/** Short label for the header chip. */
export function syncLabel(status: SyncStatus): {
  text: string;
  tone: "good" | "busy" | "warn" | "muted";
} {
  if (status.phase === "unavailable") return { text: "Local only", tone: "muted" };
  if (!status.enabled) {
    return status.pending
      ? { text: "Not synced", tone: "warn" }
      : { text: "Synced", tone: "good" };
  }
  if (status.phase === "syncing") return { text: "Saving…", tone: "busy" };
  if (status.phase === "diverged") return { text: "Conflict", tone: "warn" };
  if (status.phase === "error") return { text: "Retrying…", tone: "warn" };
  if (status.pending) return { text: "Saving…", tone: "busy" };
  return { text: "Synced", tone: "good" };
}

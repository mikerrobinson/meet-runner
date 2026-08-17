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
import { SyncRequestError, pushMeet, pushTeam, syncStatus } from "~/lib/sync";
import { useAppStore } from "~/state/app-store";

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

/** Quiet period before a push. Long enough to swallow a burst of lane taps. */
const DEBOUNCE_MS = 2500;
/** Backoff after failures — a dead pool wifi shouldn't be retried every second. */
const BACKOFF_MS = [4000, 10_000, 30_000, 60_000];

const SyncStatusContext = createContext<SyncStatus | null>(null);

export function AutoSyncProvider({ children }: { children: ReactNode }) {
  const { ready, team, meets, markTeamSynced, markMeetSynced } = useAppStore();

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
  const docsRef = useRef({ ready, team, meets });
  docsRef.current = { ready, team, meets };
  const markRef = useRef({ markTeamSynced, markMeetSynced });
  markRef.current = { markTeamSynced, markMeetSynced };

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);
  const stoppedRef = useRef(false);

  // The roster and every meet are separate documents, so "pending" means any
  // one of them is behind — and only the ones behind get pushed.
  const pendingCount =
    (team.syncedAt !== team.updatedAt ? 1 : 0) +
    meets.filter((m) => m.syncedAt !== m.updatedAt).length;
  const pending = pendingCount > 0;

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
    if (!isReady) return;
    const staleTeam =
      currentTeam.syncedAt !== currentTeam.updatedAt ? currentTeam : null;
    const staleMeets = currentMeets.filter((m) => m.syncedAt !== m.updatedAt);
    if (!staleTeam && staleMeets.length === 0) return;

    inFlightRef.current = true;
    setPhase("syncing");

    try {
      // Roster first: a meet's swimmer ids are meaningless to another device
      // until the roster they point into has landed.
      if (staleTeam) {
        const sentAt = staleTeam.updatedAt;
        await pushTeam(staleTeam);
        markRef.current.markTeamSynced(sentAt);
      }
      for (const meet of staleMeets) {
        // Remember what we're sending: edits made during the flight must stay
        // pending rather than being marked as synced.
        const sentAt = meet.updatedAt;
        await pushMeet(meet);
        markRef.current.markMeetSynced(meet.id, sentAt);
      }
      failuresRef.current = 0;
      setPhase("idle");
      setMessage(undefined);
      setLastSyncAt(Date.now());
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
      now.team.syncedAt !== now.team.updatedAt ||
      now.meets.some((m) => m.syncedAt !== m.updatedAt);
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
  }, [ready, pending, pendingCount, team.updatedAt, schedule]);

  // Coming back from a dead zone, or back to the tab, is the moment most
  // worth retrying — waiting out the backoff would be silly.
  useEffect(() => {
    const retry = () => {
      if (stoppedRef.current || !enabledRef.current) return;
      if (!docsRef.current.ready) return;
      failuresRef.current = 0;
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
  if (status.phase === "error") return { text: "Retrying…", tone: "warn" };
  if (status.pending) return { text: "Saving…", tone: "busy" };
  return { text: "Synced", tone: "good" };
}

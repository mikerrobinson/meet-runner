import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SIGNED_OUT,
  readSession,
  signOut as signOutRequest,
  updateSession,
  type Session,
} from "~/lib/auth";
import { loadSessionToken } from "~/lib/storage";

/**
 * Who's signed in on this device.
 *
 * The session is fetched once at boot and then only when something changes it.
 * It is deliberately *not* what decides whether the app runs: a device that
 * already holds the season keeps working with no network and no session, which
 * is the state a phone is in halfway through a meet when the pool wifi drops.
 * Signing in is how a season gets onto a device and how the server knows who
 * you are — not a gate in front of a stopwatch.
 */

/** The last answer, so an offline boot still knows whose device this is. */
const CACHE_KEY = "meet-runner:session-cache";

function readCache(): Session | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function writeCache(session: Session | null): void {
  if (typeof localStorage === "undefined") return;
  if (session?.user) localStorage.setItem(CACHE_KEY, JSON.stringify(session));
  else localStorage.removeItem(CACHE_KEY);
}

interface SessionState extends Session {
  /** `loading` only until the first answer — from the server or the cache. */
  status: "loading" | "in" | "out";
  /** True when the last answer came from the cache because the server was
   *  unreachable, so the app can say "offline" rather than "signed out". */
  stale: boolean;
  /** Adopt a session the sign-in screen just obtained. */
  adopt: (session: Session) => void;
  refresh: () => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;
  /** Record where this person is, so their next device opens the same place. */
  rememberPlace: (teamId: string, seasonId: string | null) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(SIGNED_OUT);
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [stale, setStale] = useState(false);

  const settle = useCallback((next: Session, fromCache = false) => {
    setSession(next);
    setStale(fromCache);
    setStatus(next.user ? "in" : "out");
    if (!fromCache) writeCache(next);
  }, []);

  const load = useCallback(async () => {
    // No token is a certain answer and needs no round trip.
    if (!loadSessionToken()) {
      writeCache(null);
      settle(SIGNED_OUT);
      return;
    }
    try {
      settle(await readSession());
    } catch {
      // Unreachable, not unauthorised — the server would have answered
      // `user: null` for a dead token. Fall back to what we last knew.
      const cached = readCache();
      settle(cached ?? SIGNED_OUT, cached !== null);
    }
  }, [settle]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<SessionState>(
    () => ({
      ...session,
      status,
      stale,
      adopt: (next) => settle(next),
      refresh: load,
      signOut: async (everywhere = false) => {
        await signOutRequest(everywhere);
        writeCache(null);
        settle(SIGNED_OUT);
      },
      // Fire-and-forget: knowing where someone was is a convenience for their
      // next sign-in, and nothing on screen should wait on it or fail with it.
      rememberPlace: (teamId, seasonId) => {
        if (!session.user) return;
        void updateSession({ lastTeamId: teamId, lastSeasonId: seasonId })
          .then((next) => settle(next))
          .catch(() => {});
      },
    }),
    [session, status, stale, settle, load],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside a SessionProvider");
  return value;
}

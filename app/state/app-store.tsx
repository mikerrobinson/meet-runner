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
import {
  migrateFromLocalStorage,
  readMeets,
  readTeam,
  removeMeet,
  writeMeet,
  writeTeam,
} from "~/lib/db";
import { createMeetDoc, createTeam } from "~/lib/documents";
import { listMeets, pullMeet, pullTeam } from "~/lib/sync";
import { buildHeats, shuffle } from "~/lib/heats";
import { generateId } from "~/lib/id";
import { isEligible } from "~/types/meet";
import type {
  Heat,
  LaneCount,
  LaneLayout,
  MeetDoc,
  MeetEvent,
  Result,
  ResultStatus,
  Swimmer,
  TeamDoc,
} from "~/types/meet";

type TeamUpdater = (team: TeamDoc) => TeamDoc;
type MeetUpdater = (meet: MeetDoc) => MeetDoc;

interface AppStore {
  /** False until IndexedDB has been read — nothing renders before then. */
  ready: boolean;
  team: TeamDoc;
  meets: MeetDoc[];

  /* Team */
  setTeamInfo: (patch: Partial<Pick<TeamDoc, "name" | "season">>) => void;
  addSwimmers: (swimmers: Swimmer[], mode: "replace" | "append") => void;
  updateSwimmer: (id: string, patch: Partial<Swimmer>) => void;
  setArchived: (id: string, archived: boolean) => void;

  /* Meets */
  createMeet: (patch?: Partial<MeetDoc>) => MeetDoc;
  deleteMeet: (id: string) => void;
  getMeet: (id: string) => MeetDoc | undefined;
  updateMeet: (id: string, updater: MeetUpdater) => void;
  replaceTeam: (team: TeamDoc) => void;
  replaceMeet: (meet: MeetDoc) => void;
  markTeamSynced: (updatedAt: number) => void;
  markMeetSynced: (id: string, updatedAt: number) => void;

  /* Meet detail — all scoped to an explicit meet id */
  setMeetInfo: (
    id: string,
    patch: Partial<Pick<MeetDoc, "name" | "date" | "type" | "opponent">>,
  ) => void;
  setLaneCount: (id: string, laneCount: LaneCount) => void;
  setLaneLayout: (id: string, laneLayout: LaneLayout) => void;
  setEvents: (id: string, events: MeetEvent[]) => void;
  addEvent: (id: string, event: MeetEvent) => void;
  updateEvent: (id: string, eventId: string, patch: Partial<MeetEvent>) => void;
  removeEvent: (id: string, eventId: string) => void;
  moveEvent: (id: string, eventId: string, direction: -1 | 1) => void;
  toggleEntry: (id: string, eventId: string, swimmerId: string) => void;
  assignToLane: (
    id: string,
    heatId: string,
    lane: number,
    swimmerId: string,
  ) => void;
  clearLane: (id: string, heatId: string, lane: number) => void;
  ensureHeats: (id: string, eventId: string) => void;
  rebuildHeats: (
    id: string,
    eventId: string,
    options?: { shuffle?: boolean },
  ) => void;
  setProgress: (id: string, eventIndex: number, heatIndex: number) => void;
  startTimer: (id: string, heatId: string) => void;
  stopLane: (id: string, heat: Heat, lane: number, elapsedMs: number) => void;
  resetHeat: (id: string, heatId: string) => void;
  recordManualTime: (
    id: string,
    heat: Heat,
    lane: number,
    swimmerId: string,
    timeMs: number,
  ) => void;
  setResultStatus: (id: string, resultId: string, status: ResultStatus) => void;
  removeResult: (id: string, resultId: string) => void;
}

const AppStoreContext = createContext<AppStore | null>(null);

/** How long a brand-new device waits on the server before setting up alone. */
const ADOPT_TIMEOUT_MS = 6000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms),
    ),
  ]);
}

/**
 * Pull the season onto a device that has none. Returns null when the server
 * has no team or can't be reached, in which case the caller starts fresh.
 */
async function adoptSeasonFromServer(): Promise<{
  team: TeamDoc;
  meets: MeetDoc[];
} | null> {
  let team: TeamDoc | null;
  try {
    team = await withTimeout(pullTeam(), ADOPT_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!team) return null;

  const meets: MeetDoc[] = [];
  try {
    const summaries = await withTimeout(listMeets(), ADOPT_TIMEOUT_MS);
    for (const summary of summaries) {
      const meet = await pullMeet(summary.id);
      // Only this team's meets: the table can hold others from a past season.
      if (meet && meet.teamId === team.id) {
        meets.push({ ...meet, syncedAt: meet.updatedAt });
      }
    }
  } catch {
    // The roster is the part that matters; meets can arrive on the next sync.
  }

  return { team: { ...team, syncedAt: team.updatedAt }, meets };
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [team, setTeam] = useState<TeamDoc>(() => createTeam());
  const [meets, setMeets] = useState<MeetDoc[]>([]);

  // Identity of what's already on disk, so a change writes only the documents
  // that actually changed rather than the whole season.
  const persistedTeam = useRef<TeamDoc | null>(null);
  const persistedMeets = useRef(new Map<string, MeetDoc>());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const migrated = await migrateFromLocalStorage();
        let loadedTeam = migrated?.team ?? (await readTeam());
        let loadedMeets = migrated?.meets ?? (await readMeets());

        // A device with nothing on it must not invent a team. The season very
        // likely already exists on the server, and minting a second one would
        // both hide the real roster and leave this device looking empty but
        // "synced". Ask the server first; only fall back to a fresh team if it
        // genuinely has none (or can't be reached).
        if (!loadedTeam) {
          const fromServer = await adoptSeasonFromServer();
          if (fromServer && !cancelled) {
            loadedTeam = fromServer.team;
            loadedMeets = fromServer.meets;
            await writeTeam(loadedTeam);
            await Promise.all(loadedMeets.map((m) => writeMeet(m)));
          }
        }

        if (cancelled) return;

        const nextTeam = loadedTeam ?? createTeam();
        setTeam(nextTeam);
        setMeets(loadedMeets);
        // A team we adopted, migrated, or read back is already on disk; only a
        // freshly created one still needs its first write. Meets are on disk in
        // every one of those paths.
        persistedTeam.current = loadedTeam ? nextTeam : null;
        persistedMeets.current = new Map(loadedMeets.map((m) => [m.id, m]));
      } catch (error) {
        console.error("Could not open local storage:", error);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist whatever changed. Writes are fire-and-forget so nothing on the
  // render path ever waits for the disk.
  useEffect(() => {
    if (!ready) return;
    if (persistedTeam.current !== team) {
      persistedTeam.current = team;
      writeTeam(team).catch((e) => console.error("Could not save the team:", e));
    }
  }, [ready, team]);

  useEffect(() => {
    if (!ready) return;
    const seen = new Set<string>();
    for (const meet of meets) {
      seen.add(meet.id);
      if (persistedMeets.current.get(meet.id) !== meet) {
        persistedMeets.current.set(meet.id, meet);
        writeMeet(meet).catch((e) => console.error("Could not save a meet:", e));
      }
    }
    for (const id of [...persistedMeets.current.keys()]) {
      if (!seen.has(id)) {
        persistedMeets.current.delete(id);
        removeMeet(id).catch((e) => console.error("Could not delete a meet:", e));
      }
    }
  }, [ready, meets]);

  /** Every team mutation goes through here so `updatedAt` can't drift. */
  const editTeam = useCallback((updater: TeamUpdater) => {
    setTeam((current) => {
      const next = updater(current);
      if (next === current) return current;
      return { ...next, updatedAt: Date.now() };
    });
  }, []);

  /** Same for meets, scoped by id. */
  const editMeet = useCallback((id: string, updater: MeetUpdater) => {
    setMeets((current) => {
      const index = current.findIndex((m) => m.id === id);
      if (index < 0) return current;
      const next = updater(current[index]);
      if (next === current[index]) return current;
      const copy = [...current];
      copy[index] = { ...next, updatedAt: Date.now() };
      return copy;
    });
  }, []);

  const store = useMemo<AppStore>(() => {
    const swimmerById = new Map(team.swimmers.map((s) => [s.id, s] as const));

    /** Registered, non-archived swimmers for an event, in roster order. */
    const entrantsFor = (meet: MeetDoc, eventId: string): string[] => {
      const registered = new Set(meet.entries[eventId] ?? []);
      return team.swimmers
        .filter((s) => !s.archived && registered.has(s.id))
        .map((s) => s.id);
    };

    const makeHeats = (meet: MeetDoc, eventId: string, reshuffle: boolean) => {
      const entrants = entrantsFor(meet, eventId);
      return buildHeats(
        eventId,
        reshuffle ? shuffle(entrants) : entrants,
        meet.options.laneCount,
      );
    };

    /**
     * Entries changed, so the event's heats are stale. Events already swum
     * keep the heats they were swum in; the UI offers a rebuild instead.
     */
    const invalidateHeats = (meet: MeetDoc, eventId: string): MeetDoc => {
      if (meet.results.some((r) => r.eventId === eventId)) return meet;
      return { ...meet, heats: meet.heats.filter((h) => h.eventId !== eventId) };
    };

    return {
      ready,
      team,
      meets,

      setTeamInfo: (patch) => editTeam((t) => ({ ...t, ...patch })),

      addSwimmers: (swimmers, mode) =>
        editTeam((t) =>
          mode === "replace"
            ? { ...t, swimmers }
            : { ...t, swimmers: [...t.swimmers, ...swimmers] },
        ),

      updateSwimmer: (id, patch) =>
        editTeam((t) => ({
          ...t,
          swimmers: t.swimmers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        })),

      // Never a hard delete: live results reference swimmers by id, so
      // removing the record would leave past meets pointing at nothing.
      setArchived: (id, archived) =>
        editTeam((t) => ({
          ...t,
          swimmers: t.swimmers.map((s) => (s.id === id ? { ...s, archived } : s)),
        })),

      createMeet: (patch) => {
        const meet = createMeetDoc(team.id, patch);
        setMeets((current) => [meet, ...current]);
        return meet;
      },

      deleteMeet: (id) => setMeets((current) => current.filter((m) => m.id !== id)),

      getMeet: (id) => meets.find((m) => m.id === id),

      updateMeet: (id, updater) => editMeet(id, updater),

      replaceTeam: (next) => {
        persistedTeam.current = null;
        setTeam(next);
      },

      replaceMeet: (next) =>
        setMeets((current) => {
          const index = current.findIndex((m) => m.id === next.id);
          if (index < 0) return [next, ...current];
          const copy = [...current];
          copy[index] = next;
          return copy;
        }),

      // Marking synced deliberately bypasses `editTeam`/`editMeet` so it
      // doesn't bump updatedAt and re-dirty the document it just cleaned.
      markTeamSynced: (updatedAt) =>
        setTeam((current) => ({ ...current, syncedAt: updatedAt })),

      markMeetSynced: (id, updatedAt) =>
        setMeets((current) =>
          current.map((m) => (m.id === id ? { ...m, syncedAt: updatedAt } : m)),
        ),

      setMeetInfo: (id, patch) => editMeet(id, (m) => ({ ...m, ...patch })),

      setLaneCount: (id, laneCount) =>
        editMeet(id, (m) => ({
          ...m,
          options: { ...m.options, laneCount },
          // Lane assignments only mean something for one pool width. Events
          // already swum keep theirs; the rest are rebuilt on arrival.
          heats: m.heats.filter((h) =>
            m.results.some((r) => r.eventId === h.eventId),
          ),
        })),

      setLaneLayout: (id, laneLayout) =>
        editMeet(id, (m) => ({ ...m, options: { ...m.options, laneLayout } })),

      setEvents: (id, events) => editMeet(id, (m) => ({ ...m, events })),

      addEvent: (id, event) =>
        editMeet(id, (m) => ({ ...m, events: [...m.events, event] })),

      updateEvent: (id, eventId, patch) =>
        editMeet(id, (m) => {
          const events = m.events.map((e) =>
            e.id === eventId ? { ...e, ...patch } : e,
          );
          const updated = events.find((e) => e.id === eventId);
          if (!updated) return m;

          // Narrowing an event's gender has to un-enter whoever no longer
          // qualifies, or they'd be seeded into a heat they can't swim.
          const before = m.entries[eventId] ?? [];
          const after = before.filter((swimmerId) => {
            const swimmer = swimmerById.get(swimmerId);
            return !swimmer || isEligible(swimmer, updated);
          });

          const next = {
            ...m,
            events,
            entries: { ...m.entries, [eventId]: after },
          };
          return after.length === before.length
            ? next
            : invalidateHeats(next, eventId);
        }),

      removeEvent: (id, eventId) =>
        editMeet(id, (m) => {
          const entries = { ...m.entries };
          delete entries[eventId];
          return {
            ...m,
            events: m.events.filter((e) => e.id !== eventId),
            entries,
            heats: m.heats.filter((h) => h.eventId !== eventId),
            results: m.results.filter((r) => r.eventId !== eventId),
            progress: { eventIndex: 0, heatIndex: 0 },
          };
        }),

      moveEvent: (id, eventId, direction) =>
        editMeet(id, (m) => {
          const index = m.events.findIndex((e) => e.id === eventId);
          const target = index + direction;
          if (index < 0 || target < 0 || target >= m.events.length) return m;
          const events = [...m.events];
          [events[index], events[target]] = [events[target], events[index]];
          return { ...m, events };
        }),

      toggleEntry: (id, eventId, swimmerId) =>
        editMeet(id, (m) => {
          const current = m.entries[eventId] ?? [];
          const next = current.includes(swimmerId)
            ? current.filter((s) => s !== swimmerId)
            : [...current, swimmerId];
          return invalidateHeats(
            { ...m, entries: { ...m.entries, [eventId]: next } },
            eventId,
          );
        }),

      /**
       * Seat a swimmer mid-meet, entering them in the event if needed.
       * Deliberately not routed through `toggleEntry`: that invalidates the
       * event's heats, which would delete the heat being edited.
       */
      assignToLane: (id, heatId, lane, swimmerId) =>
        editMeet(id, (m) => {
          const target = m.heats.find((h) => h.id === heatId);
          if (!target) return m;
          if (lane < 1 || lane > target.lanes.length) return m;

          const entered = m.entries[target.eventId] ?? [];
          return {
            ...m,
            heats: m.heats.map((h) => {
              if (h.eventId !== target.eventId) return h;
              // Nobody swims an event twice, so vacate whatever lane they
              // already held before seating them here.
              const lanes = h.lanes.map((s) => (s === swimmerId ? null : s));
              if (h.id === heatId) lanes[lane - 1] = swimmerId;
              return { ...h, lanes };
            }),
            entries: entered.includes(swimmerId)
              ? m.entries
              : { ...m.entries, [target.eventId]: [...entered, swimmerId] },
          };
        }),

      clearLane: (id, heatId, lane) =>
        editMeet(id, (m) => {
          const target = m.heats.find((h) => h.id === heatId);
          const swimmerId = target?.lanes[lane - 1];
          if (!target || !swimmerId) return m;
          // A lane with a time on it is history; clear the time first.
          if (m.results.some((r) => r.heatId === heatId && r.lane === lane)) {
            return m;
          }

          const heats = m.heats.map((h) =>
            h.id === heatId
              ? {
                  ...h,
                  lanes: h.lanes.map((s, i) => (i === lane - 1 ? null : s)),
                }
              : h,
          );

          const seededElsewhere = heats.some(
            (h) => h.eventId === target.eventId && h.lanes.includes(swimmerId),
          );
          const hasResult = m.results.some(
            (r) => r.eventId === target.eventId && r.swimmerId === swimmerId,
          );

          return {
            ...m,
            heats,
            entries:
              seededElsewhere || hasResult
                ? m.entries
                : {
                    ...m.entries,
                    [target.eventId]: (m.entries[target.eventId] ?? []).filter(
                      (s) => s !== swimmerId,
                    ),
                  },
          };
        }),

      ensureHeats: (id, eventId) =>
        editMeet(id, (m) => {
          if (m.heats.some((h) => h.eventId === eventId)) return m;
          const heats = makeHeats(m, eventId, false);
          if (heats.length === 0) return m;
          return { ...m, heats: [...m.heats, ...heats] };
        }),

      rebuildHeats: (id, eventId, options) =>
        editMeet(id, (m) => ({
          ...m,
          heats: [
            ...m.heats.filter((h) => h.eventId !== eventId),
            ...makeHeats(m, eventId, options?.shuffle ?? false),
          ],
          results: m.results.filter((r) => r.eventId !== eventId),
          timer: null,
        })),

      setProgress: (id, eventIndex, heatIndex) =>
        editMeet(id, (m) => ({
          ...m,
          progress: { eventIndex, heatIndex },
          // Never carry a running clock across a heat change.
          timer: null,
        })),

      startTimer: (id, heatId) =>
        editMeet(id, (m) => ({
          ...m,
          timer: { heatId, startedAt: Date.now() },
          results: m.results.filter((r) => r.heatId !== heatId),
        })),

      stopLane: (id, heat, lane, elapsedMs) =>
        editMeet(id, (m) => {
          const swimmerId = heat.lanes[lane - 1];
          if (!swimmerId) return m;
          if (m.results.some((r) => r.heatId === heat.id && r.lane === lane)) {
            return m;
          }
          const result: Result = {
            id: generateId(),
            eventId: heat.eventId,
            heatId: heat.id,
            swimmerId,
            lane,
            timeMs: elapsedMs,
            status: "OK",
            recordedAt: Date.now(),
          };
          return { ...m, results: [...m.results, result] };
        }),

      resetHeat: (id, heatId) =>
        editMeet(id, (m) => ({
          ...m,
          timer: null,
          results: m.results.filter((r) => r.heatId !== heatId),
        })),

      recordManualTime: (id, heat, lane, swimmerId, timeMs) =>
        editMeet(id, (m) => {
          const existing = m.results.find(
            (r) => r.heatId === heat.id && r.lane === lane,
          );
          if (existing) {
            return {
              ...m,
              results: m.results.map((r) =>
                r.id === existing.id
                  ? { ...r, timeMs, status: "OK" as ResultStatus, manual: true }
                  : r,
              ),
            };
          }
          const result: Result = {
            id: generateId(),
            eventId: heat.eventId,
            heatId: heat.id,
            swimmerId,
            lane,
            timeMs,
            status: "OK",
            recordedAt: Date.now(),
            manual: true,
          };
          return { ...m, results: [...m.results, result] };
        }),

      setResultStatus: (id, resultId, status) =>
        editMeet(id, (m) => ({
          ...m,
          results: m.results.map((r) =>
            r.id === resultId ? { ...r, status } : r,
          ),
        })),

      removeResult: (id, resultId) =>
        editMeet(id, (m) => ({
          ...m,
          results: m.results.filter((r) => r.id !== resultId),
        })),
    };
  }, [ready, team, meets, editTeam, editMeet]);

  return (
    <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new Error("useAppStore must be used inside an AppStoreProvider");
  }
  return store;
}

/** Active swimmers, in roster order — the roster minus anyone archived. */
export function activeSwimmers(team: TeamDoc): Swimmer[] {
  return team.swimmers.filter((s) => !s.archived);
}

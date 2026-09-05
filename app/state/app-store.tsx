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
import {
  createMeetDoc,
  createTeam,
  tombstone,
  type MeetPatch,
} from "~/lib/documents";
import {
  dayBefore,
  isGraduating,
  makeEnrollment,
  makeSeason,
  nextYear,
  rosterForMeet,
} from "~/lib/roster";
import { listMeets, pullMeet, pullTeam } from "~/lib/sync";
import {
  convertDistances,
  orderByLeadGender,
  withDiving,
  withoutDiving,
} from "~/lib/events";
import { buildHeats, shuffle } from "~/lib/heats";
import { makeRuling, makeWatch } from "~/lib/timing";
import { generateId } from "~/lib/id";
import {
  isDeleted,
  isDiving,
  rulingId,
  isEligible,
  normalizeTeamCode,
  todayIso,
} from "~/types/meet";
import type {
  EnrollmentStatus,
  Gender,
  Heat,
  LaneCount,
  MeetCourse,
  MeetDoc,
  MeetEvent,
  ResultStatus,
  Season,
  Swimmer,
  TeamDoc,
  WatchTime,
} from "~/types/meet";

/** One row of an import: the person, plus what's true of them this season. */
export interface RosterEntry {
  athlete: Swimmer;
  year: string;
  squad?: string;
}

type TeamUpdater = (team: TeamDoc) => TeamDoc;
type MeetUpdater = (meet: MeetDoc) => MeetDoc;

interface AppStore {
  /** False until IndexedDB has been read — nothing renders before then. */
  ready: boolean;
  team: TeamDoc;
  /** Live meets, for everything on screen. */
  meets: MeetDoc[];
  /** Deleted meets still waiting to tell the server so. Sync only. */
  deletedMeets: MeetDoc[];

  /* Team */
  setTeamInfo: (
    patch: Partial<Pick<TeamDoc, "name" | "code" | "headCoach" | "nameOrder">>,
  ) => void;
  /** Add athletes and enrol them in a season, or replace that season's roster. */
  enrol: (
    entries: RosterEntry[],
    mode: "replace" | "append",
    seasonId?: string,
  ) => void;
  /** Edit the person and their enrollment in one go — the form edits both. */
  saveAthlete: (
    athlete: Swimmer,
    facts: { year: string; squad?: string },
    seasonId?: string,
  ) => void;
  setEnrollmentStatus: (
    athleteId: string,
    status: EnrollmentStatus,
    seasonId?: string,
  ) => void;
  renameSeason: (seasonId: string, name: string) => void;
  setCurrentSeason: (seasonId: string) => void;
  /** Open a new season, carrying this one's roster into it. */
  startSeason: (name: string) => Season;

  /* Meets */
  createMeet: (patch?: MeetPatch) => MeetDoc;
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
    patch: Partial<Pick<MeetDoc, "name" | "date" | "type" | "location">>,
  ) => void;
  setCourse: (id: string, course: MeetCourse) => void;
  setLaneCount: (id: string, laneCount: LaneCount) => void;
  setLeadGender: (id: string, leadGender: Gender) => void;
  setIncludeDiving: (id: string, includeDiving: boolean) => void;
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
  /** Record this device's watch on a lane. */
  stopLane: (
    id: string,
    heat: Heat,
    lane: number,
    elapsedMs: number,
    timerId: string,
  ) => void;
  resetHeat: (id: string, heatId: string) => void;
  /** Type a time in as this device's watch. */
  recordManualTime: (
    id: string,
    heat: Heat,
    lane: number,
    timeMs: number,
    timerId: string,
  ) => void;
  /** DQ, no-show, or back to OK. A judgement, not a time. */
  setLaneStatus: (
    id: string,
    heat: Heat,
    lane: number,
    status: ResultStatus,
  ) => void;
  /** Set the official time by hand, overriding whatever the watches say. */
  overrideLaneTime: (
    id: string,
    heat: Heat,
    lane: number,
    timeMs: number,
  ) => void;
  /** Throw away everything recorded on one lane. */
  clearLaneTimes: (id: string, heat: Heat, lane: number) => void;
  /** Drop a single watch — one timer's time, not the lane's. */
  removeWatch: (id: string, watchId: string) => void;
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

  /**
   * Save without claiming the document changed.
   *
   * Some of what a meet holds isn't about the meet at all — where this device
   * has scrolled to in the running order is the obvious one. It's worth
   * remembering across a reload, so it's written to disk, but leaving
   * `updatedAt` alone keeps it from dirtying the document: tapping through
   * events on the deck shouldn't queue a push, least of all over pool wifi.
   * The position still travels with the next real edit.
   */
  const editMeetQuietly = useCallback((id: string, updater: MeetUpdater) => {
    setMeets((current) => {
      const index = current.findIndex((m) => m.id === id);
      if (index < 0) return current;
      const next = updater(current[index]);
      if (next === current[index]) return current;
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  }, []);

  const store = useMemo<AppStore>(() => {
    const liveMeets = meets.filter((m) => !isDeleted(m));
    const deletedMeets = meets.filter(isDeleted);
    const swimmerById = new Map(team.swimmers.map((s) => [s.id, s] as const));

    /** Registered swimmers for an event, in roster order. */
    const entrantsFor = (meet: MeetDoc, eventId: string): string[] => {
      const registered = new Set(meet.entries[eventId] ?? []);
      return rosterForMeet(team, meet)
        .filter((s) => registered.has(s.id))
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
      if (meet.watches.some((w) => w.eventId === eventId)) return meet;
      return { ...meet, heats: meet.heats.filter((h) => h.eventId !== eventId) };
    };

    /** Add or replace a watch, keyed by its own id so a retry is a no-op. */
    const withWatch = (meet: MeetDoc, watch: WatchTime): MeetDoc => ({
      ...meet,
      watches: [...meet.watches.filter((w) => w.id !== watch.id), watch],
    });

    /**
     * The lineup is the truth about diving; the option just reports it. Run
     * after any change to the events so pulling the last Diving event out with
     * the X also turns the setting off.
     */
    const withDivingInStep = (meet: MeetDoc): MeetDoc => {
      const includeDiving = meet.events.some(isDiving);
      return includeDiving === meet.options.includeDiving
        ? meet
        : { ...meet, options: { ...meet.options, includeDiving } };
    };

    return {
      ready,
      team,
      meets: liveMeets,
      deletedMeets,

      setTeamInfo: (patch) =>
        editTeam((t) => ({
          ...t,
          ...patch,
          code: patch.code === undefined ? t.code : normalizeTeamCode(patch.code),
        })),

      // "replace" swaps out this season's roster, not the team's history: the
      // athletes stay, so past results still resolve, and only the enrollments
      // for this season are rebuilt.
      enrol: (entries, mode, seasonId) =>
        editTeam((t) => {
          const season = seasonId ?? t.currentSeasonId;
          const athletes = [...t.swimmers];
          const enrollments =
            mode === "replace"
              ? t.enrollments.filter((e) => e.seasonId !== season)
              : [...t.enrollments];

          for (const entry of entries) {
            if (!athletes.some((a) => a.id === entry.athlete.id)) {
              athletes.push(entry.athlete);
            }
            const existing = enrollments.find(
              (e) => e.seasonId === season && e.athleteId === entry.athlete.id,
            );
            if (existing) continue;
            enrollments.push(
              makeEnrollment(t.id, season, entry.athlete.id, {
                year: entry.year,
                squad: entry.squad,
              }),
            );
          }

          return { ...t, swimmers: athletes, enrollments };
        }),

      saveAthlete: (athlete, facts, seasonId) =>
        editTeam((t) => {
          const season = seasonId ?? t.currentSeasonId;
          const known = t.swimmers.some((a) => a.id === athlete.id);
          const swimmers = known
            ? t.swimmers.map((a) => (a.id === athlete.id ? athlete : a))
            : [...t.swimmers, athlete];

          const existing = t.enrollments.find(
            (e) => e.seasonId === season && e.athleteId === athlete.id,
          );
          const enrollments = existing
            ? t.enrollments.map((e) =>
                e.id === existing.id
                  ? { ...e, year: facts.year, squad: facts.squad || undefined }
                  : e,
              )
            : [
                ...t.enrollments,
                makeEnrollment(t.id, season, athlete.id, facts),
              ];

          return { ...t, swimmers, enrollments };
        }),

      // Never a hard delete: live results reference athletes by id, so
      // removing the person would leave past meets pointing at nothing. Taking
      // someone off the roster is an enrollment that's no longer active.
      setEnrollmentStatus: (athleteId, status, seasonId) =>
        editTeam((t) => {
          const season = seasonId ?? t.currentSeasonId;
          const existing = t.enrollments.find(
            (e) => e.seasonId === season && e.athleteId === athleteId,
          );
          return {
            ...t,
            enrollments: existing
              ? t.enrollments.map((e) =>
                  e.id === existing.id ? { ...e, status } : e,
                )
              : [
                  ...t.enrollments,
                  makeEnrollment(t.id, season, athleteId, { status }),
                ],
          };
        }),

      renameSeason: (seasonId, name) =>
        editTeam((t) => ({
          ...t,
          seasons: t.seasons.map((s) =>
            s.id === seasonId ? { ...s, name } : s,
          ),
        })),

      setCurrentSeason: (seasonId) =>
        editTeam((t) => ({ ...t, currentSeasonId: seasonId })),

      // Carries the roster forward with grades advanced, which is the whole
      // point of enrollments. Anyone in their final year is left behind rather
      // than being promoted out of the school.
      //
      // The new season opens today and the old one closes yesterday, because
      // a meet finds its season by date: leave both open-ended and every meet
      // already swum would start drawing on the new roster.
      startSeason: (name) => {
        const today = todayIso();
        const season = makeSeason(team.id, name, { startDate: today });
        editTeam((t) => {
          const carried = t.enrollments
            .filter((e) => e.seasonId === t.currentSeasonId)
            .filter((e) => e.status === "active" && !isGraduating(e.year))
            .map((e) =>
              makeEnrollment(t.id, season.id, e.athleteId, {
                year: nextYear(e.year),
                squad: e.squad,
              }),
            );
          const closed = t.seasons.map((s) =>
            s.id === t.currentSeasonId && !s.endDate
              ? { ...s, endDate: dayBefore(today) }
              : s,
          );
          return {
            ...t,
            seasons: [...closed, season],
            enrollments: [...t.enrollments, ...carried],
            currentSeasonId: season.id,
          };
        });
        return season;
      },

      createMeet: (patch) => {
        const meet = createMeetDoc(team.id, patch);
        setMeets((current) => [meet, ...current]);
        return meet;
      },

      // Not a removal: the meet becomes a tombstone so the deletion can reach
      // the server and every other device. Dropping the row locally would just
      // mean the next sync handed it back.
      deleteMeet: (id) =>
        setMeets((current) =>
          current.map((m) => (m.id === id ? tombstone(m) : m)),
        ),

      getMeet: (id) => liveMeets.find((m) => m.id === id),

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

      // Moving between yards and metres converts the lineup with it, so a
      // meet switched to LCM doesn't sit there offering a 500 free.
      setCourse: (id, course) =>
        editMeet(id, (m) => ({
          ...m,
          course,
          events: convertDistances(m.events, m.course, course),
        })),

      setLaneCount: (id, laneCount) =>
        editMeet(id, (m) => ({
          ...m,
          options: { ...m.options, laneCount },
          // Lane assignments only mean something for one pool width. Events
          // already swum keep theirs; the rest are rebuilt on arrival.
          heats: m.heats.filter((h) =>
            m.watches.some((w) => w.eventId === h.eventId),
          ),
        })),

      // Reorders rather than regenerates, so entries and times survive a flip.
      setLeadGender: (id, leadGender) =>
        editMeet(id, (m) => ({
          ...m,
          options: { ...m.options, leadGender },
          events: orderByLeadGender(m.events, leadGender),
        })),

      // Diving lives in the lineup as an ordinary event, so the option is a
      // reflection of it rather than a separate setting to keep in sync.
      setIncludeDiving: (id, includeDiving) =>
        editMeet(id, (m) => {
          if (includeDiving) {
            return withDivingInStep({
              ...m,
              events: withDiving(m.events, m.options.leadGender),
            });
          }
          // Turning it off is a removal like any other, so the divers it had
          // entered go with it rather than lingering under a dead event id.
          const dropped = new Set(m.events.filter(isDiving).map((e) => e.id));
          const entries = { ...m.entries };
          for (const eventId of dropped) delete entries[eventId];
          return withDivingInStep({
            ...m,
            events: withoutDiving(m.events),
            entries,
            heats: m.heats.filter((h) => !dropped.has(h.eventId)),
            watches: m.watches.filter((w) => !dropped.has(w.eventId)),
            rulings: m.rulings.filter((r) => !dropped.has(r.eventId)),
          });
        }),

      setEvents: (id, events) =>
        editMeet(id, (m) => withDivingInStep({ ...m, events })),

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
          return withDivingInStep({
            ...m,
            events: m.events.filter((e) => e.id !== eventId),
            entries,
            heats: m.heats.filter((h) => h.eventId !== eventId),
            watches: m.watches.filter((w) => w.eventId !== eventId),
            rulings: m.rulings.filter((r) => r.eventId !== eventId),
            progress: { eventIndex: 0, heatIndex: 0 },
          });
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
          if (m.watches.some((w) => w.heatId === heatId && w.lane === lane)) {
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
          // Was this swimmer already timed in this event, in some other lane?
          const timedElsewhere = m.heats.some(
            (h) =>
              h.eventId === target.eventId &&
              h.lanes.some(
                (id, i) =>
                  id === swimmerId &&
                  m.watches.some((w) => w.heatId === h.id && w.lane === i + 1),
              ),
          );

          return {
            ...m,
            heats,
            entries:
              seededElsewhere || timedElsewhere
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
          watches: m.watches.filter((w) => w.eventId !== eventId),
          rulings: m.rulings.filter((r) => r.eventId !== eventId),
          timer: null,
        })),

      // Moving through the running order is this device's business, so it
      // saves without dirtying the document. Walking away from a live clock
      // isn't — that stops the heat, which every device needs to know.
      setProgress: (id, eventIndex, heatIndex) => {
        const stopsAClock = meets.find((m) => m.id === id)?.timer != null;
        const edit = stopsAClock ? editMeet : editMeetQuietly;
        edit(id, (m) => ({
          ...m,
          progress: { eventIndex, heatIndex },
          // Never carry a running clock across a heat change.
          timer: null,
        }));
      },

      startTimer: (id, heatId) =>
        editMeet(id, (m) => ({
          ...m,
          timer: { heatId, startedAt: Date.now() },
          // Starting again wipes this heat: the watches from the false start
          // aren't times of the race about to be swum.
          watches: m.watches.filter((w) => w.heatId !== heatId),
          rulings: m.rulings.filter((r) => r.heatId !== heatId),
        })),

      // This device's own watch. Recording again replaces its own time and
      // nobody else's, which is exactly what a timer fixing a mistake wants.
      stopLane: (id, heat, lane, elapsedMs, timerId) =>
        editMeet(id, (m) =>
          heat.lanes[lane - 1]
            ? withWatch(m, makeWatch(heat, lane, timerId, elapsedMs, "stopwatch"))
            : m,
        ),

      resetHeat: (id, heatId) =>
        editMeet(id, (m) => ({
          ...m,
          timer: null,
          watches: m.watches.filter((w) => w.heatId !== heatId),
          rulings: m.rulings.filter((r) => r.heatId !== heatId),
        })),

      recordManualTime: (id, heat, lane, timeMs, timerId) =>
        editMeet(id, (m) => {
          const next = withWatch(
            m,
            makeWatch(heat, lane, timerId, timeMs, "typed"),
          );
          // Typing a time is also a statement that the swim counts, so it
          // clears any override that was standing in its place.
          return {
            ...next,
            rulings: next.rulings.filter(
              (r) => r.id !== rulingId(heat.id, lane),
            ),
          };
        }),

      setLaneStatus: (id, heat, lane, status) =>
        editMeet(id, (m) => {
          const rulings = m.rulings.filter(
            (r) => r.id !== rulingId(heat.id, lane),
          );
          return status === "OK"
            ? { ...m, rulings }
            : { ...m, rulings: [...rulings, makeRuling(heat, lane, status)] };
        }),

      overrideLaneTime: (id, heat, lane, timeMs) =>
        editMeet(id, (m) => ({
          ...m,
          rulings: [
            ...m.rulings.filter((r) => r.id !== rulingId(heat.id, lane)),
            makeRuling(heat, lane, "OK", timeMs),
          ],
        })),

      clearLaneTimes: (id, heat, lane) =>
        editMeet(id, (m) => ({
          ...m,
          watches: m.watches.filter(
            (w) => !(w.heatId === heat.id && w.lane === lane),
          ),
          rulings: m.rulings.filter((r) => r.id !== rulingId(heat.id, lane)),
        })),

      removeWatch: (id, watchId) =>
        editMeet(id, (m) => ({
          ...m,
          watches: m.watches.filter((w) => w.id !== watchId),
        })),
    };
  }, [ready, team, meets, editTeam, editMeet, editMeetQuietly]);

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

/** Everyone enterable in this meet: the roster of the season it falls in. */
export function activeSwimmers(team: TeamDoc, meet: MeetDoc): Swimmer[] {
  return rosterForMeet(team, meet);
}

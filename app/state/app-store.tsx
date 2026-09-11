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
  readAthletes,
  readMeets,
  readTeam,
  removeMeet,
  writeAthletes,
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
import { exchange } from "~/lib/sync";
import { fromObjects, type SyncObject } from "~/lib/objects";
import { writeBaseline, writeCursor } from "~/lib/db";
import {
  convertDistances,
  orderByLeadGender,
  withDiving,
  withoutDiving,
} from "~/lib/events";
import { buildHeats, shuffle } from "~/lib/heats";
import {
  acceptResult,
  activeLanes,
  makeRuling,
  makeWatch,
} from "~/lib/timing";
import { generateId } from "~/lib/id";
import {
  acceptedResultId,
  isDeleted,
  isDiving,
  rulingId,
  normalizeTeamCode,
  todayIso,
} from "~/types/meet";
import type {
  AcceptedResult,
  EnrollmentStatus,
  Gender,
  Heat,
  LaneCount,
  MeetCourse,
  MeetDoc,
  MeetEvent,
  ResultStatus,
  Season,
  Athlete,
  TeamDoc,
  WatchTime,
} from "~/types/meet";

/** One row of an import: the person, plus what's true of them this season. */
export interface RosterEntry {
  athlete: Athlete;
  year: string;
  squad?: string;
}

type TeamUpdater = (team: TeamDoc) => TeamDoc;
type MeetUpdater = (meet: MeetDoc) => MeetDoc;

interface AppStore {
  /** False until IndexedDB has been read — nothing renders before then. */
  ready: boolean;
  /** Set when on-device storage couldn't be opened at all. */
  storageError: string | null;
  /**
   * Whether this device actually holds a season, as opposed to the empty
   * placeholder it starts with. A device with one keeps working offline and
   * signed out; a device without one has to be told which season it's for.
   */
  hasLocalData: boolean;
  /** Take a season from the server, replacing whatever is here. */
  chooseTeam: (teamId: string) => Promise<void>;
  /** Start a season from nothing, under an id the server has already agreed
   *  belongs to this coach. */
  startFreshTeam: (name: string, id: string) => void;
  team: TeamDoc;
  /**
   * Everyone this device knows about, from any team.
   *
   * Not the roster — that's this set filtered by the team's enrollments, which
   * is what `rosterFor` does. Holding people separately is what lets a visiting
   * swimmer be a real person rather than a copy on our roster.
   */
  athletes: Athlete[];
  /** Live meets, for everything on screen. */
  meets: MeetDoc[];
  /** Deleted meets still waiting to tell the server so. Sync only. */
  deletedMeets: MeetDoc[];

  /* Team */
  setTeamInfo: (
    patch: Partial<Pick<TeamDoc, "name" | "code">>,
  ) => void;
  /** Add athletes and enrol them in a season, or replace that season's roster. */
  enrol: (
    entries: RosterEntry[],
    mode: "replace" | "append",
    seasonId?: string,
  ) => void;
  /** Edit the person and their enrollment in one go — the form edits both. */
  saveAthlete: (
    athlete: Athlete,
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
  replaceTeam: (team: TeamDoc) => void;
  replaceAthletes: (athletes: Athlete[]) => void;
  replaceMeet: (meet: MeetDoc) => void;
  /** Take on what a sync brought back, keeping this device's own view of things. */
  applyFromSync: (team: TeamDoc, athletes: Athlete[], meets: MeetDoc[]) => void;

  /* Meet detail — all scoped to an explicit meet id */
  setMeetInfo: (
    id: string,
    patch: Partial<
      Pick<MeetDoc, "name" | "date" | "type" | "location" | "teamIds" | "hostTeamId">
    >,
  ) => void;
  setCourse: (id: string, course: MeetCourse) => void;
  setLaneCount: (id: string, laneCount: LaneCount) => void;
  setLeadGender: (id: string, leadGender: Gender) => void;
  setIncludeDiving: (id: string, includeDiving: boolean) => void;
  setEvents: (id: string, events: MeetEvent[]) => void;
  addEvent: (id: string, event: MeetEvent) => void;
  removeEvent: (id: string, eventId: string) => void;
  moveEvent: (id: string, eventId: string, direction: -1 | 1) => void;
  toggleEntry: (id: string, eventId: string, athleteId: string) => void;
  assignToLane: (
    id: string,
    heatId: string,
    lane: number,
    athleteId: string,
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
    by?: string,
  ) => void;
  /**
   * Enter the time by hand. A claim in its own right, recorded with who made
   * it and when, and outranking the watches wherever it's set.
   */
  overrideLaneTime: (
    id: string,
    heat: Heat,
    lane: number,
    timeMs: number,
    by?: string,
  ) => void;
  /** Throw away everything recorded on one lane. */
  clearLaneTimes: (id: string, heat: Heat, lane: number) => void;
  /** Drop a single watch — one timer's time, not the lane's. */
  removeWatch: (id: string, watchId: string) => void;

  /* Signing off — what makes a time official */

  /**
   * Accept a lane, as it stands or corrected. `by` is the account doing it.
   *
   * The correction and the acceptance are one act on purpose: an administrator
   * looking at a lane either agrees with the watches or doesn't, and either
   * way what they decide is the result.
   */
  acceptLane: (
    id: string,
    heat: Heat,
    lane: number,
    by: string | undefined,
    override?: Partial<Pick<AcceptedResult, "timeMs" | "status" | "athleteId">>,
  ) => void;
  /** Take a sign-off back, returning the lane to what the watches say. */
  unacceptLane: (id: string, heat: Heat, lane: number) => void;
  /** Accept every lane in a heat that hasn't been signed off yet. */
  acceptHeat: (id: string, heat: Heat, by: string | undefined) => void;
}

const AppStoreContext = createContext<AppStore | null>(null);

/**
 * Pull a season onto a device.
 *
 * Which season is no longer a guess: it's the team the signed-in coach belongs
 * to, decided by the server. This device only has to fetch it.
 */
export async function adoptTeam(teamId: string): Promise<{
  team: TeamDoc;
  athletes: Athlete[];
  meets: MeetDoc[];
} | null> {
  const objects: SyncObject[] = [];
  let cursor = "";

  // Page through the whole season. Objects, not documents: the old document
  // tables stopped being the truth when syncing moved to objects.
  for (let page = 0; page < 100; page++) {
    const result = await exchange(teamId, cursor, []);
    objects.push(...result.changes);
    cursor = result.cursor;
    if (!result.more) break;
  }

  const { teams, athletes, meets } = fromObjects(objects);
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;

  // Seed the baseline, or this device's first sync would push the season
  // straight back as though it had just written all of it.
  await writeBaseline(objects);
  await writeCursor(cursor);

  return { team, athletes, meets };
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [hasLocalData, setHasLocalData] = useState(false);
  const [team, setTeam] = useState<TeamDoc>(() => createTeam());
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [meets, setMeets] = useState<MeetDoc[]>([]);

  // Identity of what's already on disk, so a change writes only the documents
  // that actually changed rather than the whole season.
  const persistedTeam = useRef<TeamDoc | null>(null);
  const persistedAthletes = useRef<Athlete[] | null>(null);
  const persistedMeets = useRef(new Map<string, MeetDoc>());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const loadedTeam = await readTeam();
        const loadedAthletes = await readAthletes();
        const loadedMeets = await readMeets(
          loadedTeam ? [loadedTeam.id] : undefined,
        );
        if (cancelled) return;

        // A device with nothing on it must not invent a team: the season very
        // likely already exists on the server under an id this device can't
        // guess, and minting a second one would both hide the real roster and
        // leave the device looking empty but "synced". The placeholder here is
        // never persisted or pushed — the shell sends you to sign in instead,
        // and whoever you turn out to be decides which season to fetch.
        const nextTeam = loadedTeam ?? createTeam();
        setTeam(nextTeam);
        setAthletes(loadedAthletes);
        setMeets(loadedMeets);
        setHasLocalData(loadedTeam !== null);
        // A team read back is already on disk; the placeholder isn't, and
        // must not be written just because it exists.
        persistedTeam.current = nextTeam;
        persistedAthletes.current = loadedAthletes;
        persistedMeets.current = new Map(loadedMeets.map((m) => [m.id, m]));
      } catch (error) {
        console.error("Could not open local storage:", error);
        if (!cancelled) {
          setStorageError(
            error instanceof Error ? error.message : "Storage is unavailable.",
          );
        }
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
    if (persistedAthletes.current !== athletes) {
      persistedAthletes.current = athletes;
      writeAthletes(athletes).catch((e) =>
        console.error("Could not save the roster:", e),
      );
    }
  }, [ready, athletes]);

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
    const liveMeets = meets.filter((m) => !isDeleted(m));
    const deletedMeets = meets.filter(isDeleted);

    /** Registered swimmers for an event, in roster order. */
    const entrantsFor = (meet: MeetDoc, eventId: string): string[] => {
      const registered = new Set(meet.entries[eventId] ?? []);
      return rosterForMeet(athletes, team, meet)
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
      storageError,
      hasLocalData,

      chooseTeam: async (teamId) => {
        const adopted = await adoptTeam(teamId);
        if (!adopted) throw new Error("That season has gone from the server.");
        persistedTeam.current = null;
        setTeam(adopted.team);
        setMeets(adopted.meets);
        setHasLocalData(true);
      },

      // The id comes from the caller because the server has already been told
      // this coach owns it — minting a different one here would leave the
      // device working in a season nobody owns.
      startFreshTeam: (name, id) => {
        const fresh = createTeam(name, id);
        persistedTeam.current = null;
        setTeam(fresh);
        setMeets([]);
        setHasLocalData(true);
      },

      team,
      athletes,
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
      enrol: (entries, mode, seasonId) => {
        // Two collections now, and the people are the durable half: a
        // "replace" rebuilds this season's enrollments and touches nobody's
        // record, so past results still resolve to a name.
        setAthletes((current) => {
          const known = new Set(current.map((a) => a.id));
          const added = entries
            .map((entry) => entry.athlete)
            .filter((athlete) => !known.has(athlete.id));
          return added.length > 0 ? [...current, ...added] : current;
        });

        editTeam((t) => {
          const season = seasonId ?? t.currentSeasonId;
          const enrollments =
            mode === "replace"
              ? t.enrollments.filter((e) => e.seasonId !== season)
              : [...t.enrollments];

          for (const entry of entries) {
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

          return { ...t, enrollments };
        });
      },

      saveAthlete: (athlete, facts, seasonId) => {
        setAthletes((current) =>
          current.some((a) => a.id === athlete.id)
            ? current.map((a) => (a.id === athlete.id ? athlete : a))
            : [...current, athlete],
        );

        editTeam((t) => {
          const season = seasonId ?? t.currentSeasonId;
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

          return { ...t, enrollments };
        });
      },

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

      replaceTeam: (next) => {
        persistedTeam.current = null;
        setTeam(next);
      },

      replaceAthletes: (next) => {
        persistedAthletes.current = null;
        setAthletes(next);
      },

      // The merged season, recomposed from objects. Where the device has a
      // view of its own — which event it's sitting on — that's kept: it was
      // never the server's to have an opinion about.
      applyFromSync: (nextTeam, nextAthletes, nextMeets) => {
        setTeam(nextTeam);
        setAthletes(nextAthletes);
        setMeets((current) => {
          const localById = new Map(current.map((m) => [m.id, m] as const));
          return nextMeets.map((meet) => {
            const local = localById.get(meet.id);
            return local ? { ...meet, progress: local.progress } : meet;
          });
        });
      },

      replaceMeet: (next) =>
        setMeets((current) => {
          const index = current.findIndex((m) => m.id === next.id);
          if (index < 0) return [next, ...current];
          const copy = [...current];
          copy[index] = next;
          return copy;
        }),

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

      toggleEntry: (id, eventId, athleteId) =>
        editMeet(id, (m) => {
          const current = m.entries[eventId] ?? [];
          const next = current.includes(athleteId)
            ? current.filter((s) => s !== athleteId)
            : [...current, athleteId];
          return invalidateHeats(
            { ...m, entries: { ...m.entries, [eventId]: next } },
            eventId,
          );
        }),

      /**
       * Seat a athlete mid-meet, entering them in the event if needed.
       * Deliberately not routed through `toggleEntry`: that invalidates the
       * event's heats, which would delete the heat being edited.
       */
      assignToLane: (id, heatId, lane, athleteId) =>
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
              const lanes = h.lanes.map((s) => (s === athleteId ? null : s));
              if (h.id === heatId) lanes[lane - 1] = athleteId;
              return { ...h, lanes };
            }),
            entries: entered.includes(athleteId)
              ? m.entries
              : { ...m.entries, [target.eventId]: [...entered, athleteId] },
          };
        }),

      clearLane: (id, heatId, lane) =>
        editMeet(id, (m) => {
          const target = m.heats.find((h) => h.id === heatId);
          const athleteId = target?.lanes[lane - 1];
          if (!target || !athleteId) return m;
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
            (h) => h.eventId === target.eventId && h.lanes.includes(athleteId),
          );
          // Was this athlete already timed in this event, in some other lane?
          const timedElsewhere = m.heats.some(
            (h) =>
              h.eventId === target.eventId &&
              h.lanes.some(
                (id, i) =>
                  id === athleteId &&
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
                      (s) => s !== athleteId,
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

      // Where this device sits in the running order isn't synced at all — it
      // never becomes an object — so moving through events costs nothing on
      // the wire. Stopping a live clock does change the meet, and says so.
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

      setLaneStatus: (id, heat, lane, status, by) =>
        editMeet(id, (m) => {
          const existing = m.rulings.find((r) => r.id === rulingId(heat.id, lane));
          const rulings = m.rulings.filter(
            (r) => r.id !== rulingId(heat.id, lane),
          );
          // A status of OK with no typed time is no judgement at all, so the
          // ruling goes rather than lingering as an empty one.
          if (status === "OK" && existing?.timeMs === undefined) {
            return { ...m, rulings };
          }
          return {
            ...m,
            rulings: [
              ...rulings,
              // Keeps whatever time was typed: marking a DQ shouldn't discard
              // the official's own reading of the clock.
              makeRuling(heat, lane, status, existing?.timeMs, by),
            ],
          };
        }),

      overrideLaneTime: (id, heat, lane, timeMs, by) =>
        editMeet(id, (m) => {
          const existing = m.rulings.find((r) => r.id === rulingId(heat.id, lane));
          return {
            ...m,
            rulings: [
              ...m.rulings.filter((r) => r.id !== rulingId(heat.id, lane)),
              // And the reverse: typing a time shouldn't quietly undo a DQ.
              makeRuling(heat, lane, existing?.status ?? "OK", timeMs, by),
            ],
          };
        }),

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

      acceptLane: (id, heat, lane, by, override) =>
        editMeet(id, (m) => {
          const accepted = acceptResult(m, heat, lane, by, override);
          if (!accepted) return m;
          return {
            ...m,
            results: [
              ...m.results.filter((r) => r.id !== accepted.id),
              accepted,
            ],
          };
        }),

      unacceptLane: (id, heat, lane) =>
        editMeet(id, (m) => ({
          ...m,
          results: m.results.filter(
            (r) => r.id !== acceptedResultId(heat.id, lane),
          ),
        })),

      acceptHeat: (id, heat, by) =>
        editMeet(id, (m) => {
          // Only the lanes still outstanding, so "accept all" never quietly
          // rewrites a correction somebody already made.
          const pending = activeLanes(m, heat).filter(
            (lane) => !m.results.some((r) => r.id === acceptedResultId(heat.id, lane)),
          );
          if (pending.length === 0) return m;

          const added = pending
            .map((lane) => acceptResult(m, heat, lane, by))
            .filter((r): r is AcceptedResult => r !== null);
          return { ...m, results: [...m.results, ...added] };
        }),
    };
  }, [
    ready,
    storageError,
    hasLocalData,
    team,
    athletes,
    meets,
    editTeam,
    editMeet,
  ]);

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


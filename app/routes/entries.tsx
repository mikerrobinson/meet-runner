import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Route } from "./+types/entries";
import { AthleteSheet } from "~/components/AthleteSheet";
import { Button, EmptyState, TextInput } from "~/components/ui";
import { enrollmentIndex, rosterForMeet, seasonForMeet } from "~/lib/roster";
import { useAppStore } from "~/state/app-store";
import { canEditEntriesFor, canSeeEntries, useMeetRole } from "~/state/meet-role";
import { entrySplit, whyNotEnter } from "~/lib/events";
import { useViewPrefs } from "~/state/view-prefs";
import {
  byAthlete,
  displayName,
  raceKey,
  shortStroke,
  type Gender,
  type MeetEvent,
  type Stroke,
  type Athlete,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Entries · Meet Runner" }];
}

/**
 * Hidden for now so the grid gets the whole screen. Flip to true to bring back
 * the search box and the "+ Swimmer" button; swimmers can still be added under
 * Team either way.
 */
const SHOW_ROSTER_CONTROLS = false;

/**
 * Zebra striping. Both tones are fully opaque: the name column is sticky, so a
 * translucent background would let the cells scrolling underneath show through.
 */
const ROW_TONES = [
  { name: "bg-white dark:bg-slate-900", cell: "bg-white dark:bg-slate-900" },
  {
    name: "bg-slate-50 dark:bg-slate-800",
    cell: "bg-slate-50 dark:bg-slate-800",
  },
];

/** Width of the pinned athlete column. */
const NAME_COL = "9rem";
/** Floor for a race column before the grid starts scrolling sideways. */
const MIN_RACE_COL = "3.5rem";

/**
 * One column of the grid: a distance/stroke pair, holding whichever gendered
 * versions of it the lineup contains. A split lineup swims each race twice,
 * but there's no reason to make the coach tap through twice as many columns
 * when the swimmer's gender already says which of the two they belong in.
 */
interface Race {
  key: string;
  distance: number;
  stroke: Stroke;
  /**
   * 1-based event numbers in swum order — what the meet program calls them.
   * Kept off the header to save a line, but surfaced in its tooltip.
   */
  numbers: number[];
  girls?: MeetEvent;
  boys?: MeetEvent;
  open?: MeetEvent;
}

/** The event in this race that a given athlete would actually swim. */
/** How a race reads in prose — diving has no distance worth printing. */
function raceLabel(race: Race): string {
  return race.stroke === "Diving"
    ? "Diving"
    : `${race.distance} ${race.stroke}`;
}

function eventFor(race: Race, athlete: Athlete): MeetEvent | undefined {
  const own = athlete.gender === "F" ? race.girls : race.boys;
  return own ?? race.open;
}

export default function Registration() {
  const { team, athletes, meets, toggleEntry, enrol } = useAppStore();
  const role = useMeetRole();
  const { nameOrder } = useViewPrefs();
  const { meetId } = useParams();
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const meet = meets.find((m) => m.id === meetId);

  const param = params.get("g");
  const genderFilter: Gender | "all" =
    param === "f" ? "F" : param === "m" ? "M" : "all";

  const seasonId = meet ? seasonForMeet(team, meet)?.id : undefined;
  const enrollments = useMemo(
    () => enrollmentIndex(team, seasonId),
    [team, seasonId],
  );

  /**
   * Everyone enterable in this meet, before the screen's own filters.
   *
   * Kept separate from `swimmers` because the column counts have to mean the
   * same thing whatever the Girls/Boys toggle is set to — counting the visible
   * rows would make a header change when you filtered, which is a header
   * measuring the wrong thing.
   */
  const roster = useMemo(
    () => (meet ? rosterForMeet(athletes, team, meet) : []),
    [athletes, team, meet],
  );

  const swimmers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return roster
      .filter((s) => genderFilter === "all" || s.gender === genderFilter)
      .filter(
        (s) =>
          !query ||
          `${s.firstName} ${s.lastName}`.toLowerCase().includes(query),
      )
      .sort(byAthlete(nameOrder));
  }, [roster, genderFilter, search, nameOrder]);

  // Changing the filter changes which rows exist. Holding the old scroll
  // offset would leave you looking at an arbitrary slice of the new list
  // instead of its start, which reads as the list having reordered itself.
  // Vertical only — which columns you're on is a separate question.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = 0;
  }, [genderFilter]);

  /** Collapse the lineup into races, keeping the order they're first swum in. */
  const races = useMemo(() => {
    const byKey = new Map<string, Race>();
    (meet?.events ?? []).forEach((event, index) => {
      const key = raceKey(event);
      let race = byKey.get(key);
      if (!race) {
        race = {
          key,
          distance: event.distance,
          stroke: event.stroke,
          numbers: [],
        };
        byKey.set(key, race);
      }
      race.numbers.push(index + 1);
      // First one wins, so a lineup with accidental duplicates stays sane.
      if (event.gender === "F") race.girls ??= event;
      else if (event.gender === "M") race.boys ??= event;
      else race.open ??= event;
    });
    return [...byKey.values()];
  }, [meet?.events]);

  /** Registration lookup as a set of "eventId|athleteId" keys. */
  const registered = useMemo(() => {
    const keys = new Set<string>();
    for (const [eventId, ids] of Object.entries(meet?.entries ?? {})) {
      for (const id of ids) keys.add(`${eventId}|${id}`);
    }
    return keys;
  }, [meet?.entries]);

  const perAthlete = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ids of Object.values(meet?.entries ?? {})) {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [meet?.entries]);

  if (!meet) return null;

  // A meet can keep lineups to the teams they belong to. Before the racing, a
  // lineup is competitive information; a reader with no stake in the meet has
  // no claim on it, and the results are public either way.
  if (!canSeeEntries(role, meet)) {
    return (
      <EmptyState title="Entries aren't public for this meet">
        The coaches involved can see their own. Results appear here as they
        happen, whatever this is set to.
      </EmptyState>
    );
  }

  // Counts what the grid can actually show. An entry naming somebody who
  // isn't on the roster — a leftover from a re-import, which mints new ids —
  // draws no row, so counting it here made the header disagree with the ticks
  // underneath it.
  const known = new Set(roster.map((a) => a.id));
  const entryCount = (event?: MeetEvent) =>
    event ? entrySplit(meet, event.id, known).entered : 0;
  const orphanCount = meet.events.reduce(
    (total, event) => total + entrySplit(meet, event.id, known).orphaned,
    0,
  );

  /** The count line under a column header, phrased for the current filter. */
  const headerCount = (race: Race): string => {
    if (genderFilter === "F")
      return String(entryCount(race.girls ?? race.open));
    if (genderFilter === "M") return String(entryCount(race.boys ?? race.open));
    if (race.girls && race.boys) {
      return `${entryCount(race.girls)}/${entryCount(race.boys)}`;
    }
    if (race.girls) return `G ${entryCount(race.girls)}`;
    if (race.boys) return `B ${entryCount(race.boys)}`;
    return String(entryCount(race.open));
  };

  if (races.length === 0 || swimmers.length === 0) {
    return (
      <EmptyState title="Nothing to register yet">
        {rosterForMeet(athletes, team, meet).length === 0 ? (
          <>
            The team roster is empty.{" "}
            <Link to="/team" className="font-semibold text-blue-600 underline">
              Add swimmers
            </Link>
            .
          </>
        ) : races.length === 0 ? (
          <>
            This meet has no events.{" "}
            <Link
              to={`/meets/${meet.id}/setup`}
              className="font-semibold text-blue-600 underline"
            >
              Set them up
            </Link>
            .
          </>
        ) : (
          <>No {genderFilter === "F" ? "girls" : "boys"} on the roster.</>
        )}
      </EmptyState>
    );
  }

  return (
    /* Sized to the gap between the app chrome so the grid — not the page —
       owns vertical scrolling. Sticky headers pin to their scroll container,
       so the header row only stays put if that container is the thing
       scrolling. The negative margins bleed it past the shell's padding so
       every pixel of the window goes to the grid. */
    <div
      className="-mt-4 flex flex-col"
      style={{
        maxHeight:
          "calc(100dvh - var(--app-chrome-top) - var(--app-chrome-bottom) - 1rem)",
      }}
    >
      {/* A count that doesn't match the ticks below it is the kind of thing
          somebody notices mid-meet and can't explain. Say it plainly instead. */}
      {orphanCount > 0 && (
        <div className="mt-3 shrink-0 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {orphanCount} {orphanCount === 1 ? "entry points" : "entries point"} at
          swimmers who aren&rsquo;t on this season&rsquo;s roster, so
          {orphanCount === 1 ? " it isn't" : " they aren't"} shown below. That
          usually means the roster was re-imported — which gives everyone new
          ids and leaves the old entries pointing at the old ones.
        </div>
      )}

      {SHOW_ROSTER_CONTROLS && (
        <div className="shrink-0 space-y-3 py-3">
          <div className="flex gap-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search swimmers"
            />
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Athlete
            </Button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Tap a cell to enter or scratch a athlete. Greyed cells are races the
            athlete isn't eligible for.
          </p>
        </div>
      )}

      {/* One scroll container: the name column pins left, headers pin top. */}
      <div
        ref={scrollerRef}
        className="-mx-4 min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        {/* table-fixed + w-full spreads the race columns evenly across
            whatever width is left over. minWidth keeps them tappable once
            there are more races than the screen can spread out, at which
            point the container scrolls sideways instead. */}
        <table
          className="w-full table-fixed border-separate border-spacing-0"
          style={{
            minWidth: `calc(${NAME_COL} + ${races.length} * ${MIN_RACE_COL})`,
          }}
        >
          <thead>
            <tr>
              <th
                style={{ width: NAME_COL }}
                className="sticky left-0 top-0 z-30 border-b border-r border-slate-300 bg-slate-100 px-2 py-1 text-left text-xs font-bold dark:border-slate-700 dark:bg-slate-800"
              >
                Athlete
              </th>
              {races.map((race) => (
                <th
                  key={race.key}
                  className="sticky top-0 z-20 border-b border-r border-slate-300 bg-slate-100 px-0.5 py-1 text-center text-[11px] font-bold leading-tight dark:border-slate-700 dark:bg-slate-800"
                  title={`${raceLabel(race)} · event ${race.numbers.join(", ")}`}
                >
                  {race.stroke === "Diving" ? (
                    // No distance to show, so the name takes both lines.
                    <span className="block py-1.5">Diving</span>
                  ) : (
                    <>
                      <span className="block">{race.distance}</span>
                      <span className="block">{shortStroke(race.stroke)}</span>
                    </>
                  )}
                  <span className="block font-normal text-slate-500">
                    {headerCount(race)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {swimmers.map((athlete, rowIndex) => {
              const tone = ROW_TONES[rowIndex % ROW_TONES.length];
              return (
                <tr key={athlete.id}>
                  <th
                    scope="row"
                    style={{ width: NAME_COL }}
                    className={`sticky left-0 z-10 border-b border-r border-slate-300 px-2 py-1 text-left dark:border-slate-700 ${tone.name}`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {displayName(athlete, nameOrder)}
                    </span>
                    <span className="block text-[11px] font-normal text-slate-500">
                      {athlete.gender}
                      {enrollments.get(athlete.id)?.year &&
                        ` · ${enrollments.get(athlete.id)?.year}`}{" "}
                      · {perAthlete.get(athlete.id) ?? 0} ev
                    </span>
                  </th>
                  {races.map((race) => {
                    // The gendered event this athlete belongs in; absent means
                    // the lineup has no version of this race for them.
                    const event = eventFor(race, athlete);
                    const isIn =
                      event !== undefined &&
                      registered.has(`${event.id}|${athlete.id}`);
                    // Who may change this cell is a per-swimmer question: an
                    // administrator may change any, a coach only their own
                    // team's, a swimmer only their own and only when the meet
                    // allows it.
                    const mayEdit =
                      event !== undefined &&
                      // Every row here is from this device's team — the grid
                      // draws that roster. An administrator's multi-team grid
                      // is still to come.
                      canEditEntriesFor(role, meet, athlete.id, team.id);
                    // Entry limits are the meet's rules, so they're checked
                    // here rather than discovered after the tap.
                    const blocked =
                      event !== undefined && !isIn
                        ? whyNotEnter(meet, athlete.id, event.id)
                        : null;
                    const locked = event !== undefined && (!mayEdit || blocked !== null);
                    return (
                      <td
                        key={race.key}
                        className="border-b border-r border-slate-300 p-0 dark:border-slate-700"
                      >
                        <button
                          type="button"
                          disabled={event === undefined || locked}
                          aria-pressed={isIn}
                          aria-label={`${displayName(athlete, nameOrder)} in ${raceLabel(race)}`}
                          // The reason travels with the control, so a cell
                          // that won't take a tap can say why instead of just
                          // refusing.
                          title={blocked ?? undefined}
                          onClick={() =>
                            event && toggleEntry(meet.id, event.id, athlete.id)
                          }
                          className={`flex h-12 w-full touch-manipulation items-center justify-center text-xl font-bold transition-colors ${
                            event === undefined
                              ? "cursor-not-allowed bg-slate-100 text-slate-300 dark:bg-slate-800/60 dark:text-slate-700"
                              : isIn
                                ? `bg-emerald-500 text-white ${mayEdit ? "active:bg-emerald-600" : "opacity-80"}`
                                : locked
                                  ? `${tone.cell} cursor-not-allowed text-transparent`
                                  : `${tone.cell} text-transparent active:bg-slate-200 dark:active:bg-slate-700`
                          }`}
                        >
                          {event === undefined ? "·" : "✓"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <AthleteSheet
          title="Add swimmer"
          onClose={() => setAdding(false)}
          onSave={(athlete, facts) => {
            enrol([{ athlete: athlete, ...facts }], "append", seasonId);
            setAdding(false);
            setSearch("");
          }}
        />
      )}
    </div>
  );
}

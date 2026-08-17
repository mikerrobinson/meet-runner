import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Route } from "./+types/registration";
import { SwimmerSheet } from "~/components/SwimmerSheet";
import { Button, EmptyState, TextInput } from "~/components/ui";
import { activeSwimmers, useAppStore } from "~/state/app-store";
import { eventName, isEligible, shortName, type Swimmer } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Registration · Meet Runner" }];
}

/**
 * Hidden for now so the grid gets the whole screen. Flip to true to bring back
 * the search box and the "+ Swimmer" button; swimmers can still be added under
 * Setup → Roster either way.
 */
const SHOW_ROSTER_CONTROLS = false;

/** Width of the pinned swimmer column. */
const NAME_COL = "9rem";
/** Floor for an event column before the grid starts scrolling sideways. */
const MIN_EVENT_COL = "3.5rem";

export default function Registration() {
  const { team, meets, toggleEntry, addSwimmers } = useAppStore();
  const { meetId } = useParams();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  const meet = meets.find((m) => m.id === meetId);

  const swimmers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const roster = activeSwimmers(team);
    if (!query) return roster;
    return roster.filter((s) =>
      `${s.firstName} ${s.lastName}`.toLowerCase().includes(query),
    );
  }, [team, search]);

  /** Registration lookup as a set of "eventId|swimmerId" keys. */
  const registered = useMemo(() => {
    const keys = new Set<string>();
    for (const [eventId, ids] of Object.entries(meet?.entries ?? {})) {
      for (const id of ids) keys.add(`${eventId}|${id}`);
    }
    return keys;
  }, [meet?.entries]);

  const perSwimmer = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ids of Object.values(meet?.entries ?? {})) {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [meet?.entries]);

  if (!meet) return null;

  if (meet.events.length === 0 || swimmers.length === 0) {
    return (
      <EmptyState title="Nothing to register yet">
        {swimmers.length === 0 ? (
          <>
            The team roster is empty.{" "}
            <Link to="/team" className="font-semibold text-blue-600 underline">
              Add swimmers
            </Link>
            .
          </>
        ) : (
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
      {SHOW_ROSTER_CONTROLS && (
        <div className="shrink-0 space-y-3 py-3">
          <div className="flex gap-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search swimmers"
            />
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Swimmer
            </Button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Tap a cell to enter or scratch a swimmer. Greyed cells are events
            the swimmer isn't eligible for.
          </p>
        </div>
      )}

      {/* One scroll container: the name column pins left, headers pin top. */}
      <div className="-mx-4 min-h-0 flex-1 overflow-auto overscroll-contain">
        {/* table-fixed + w-full spreads the event columns evenly across
            whatever width is left over. minWidth keeps them tappable once
            there are more events than the screen can spread out, at which
            point the container scrolls sideways instead. */}
        <table
          className="w-full table-fixed border-separate border-spacing-0"
          style={{
            minWidth: `calc(${NAME_COL} + ${meet.events.length} * ${MIN_EVENT_COL})`,
          }}
        >
          <thead>
            <tr>
              <th
                style={{ width: NAME_COL }}
                className="sticky left-0 top-0 z-30 border-b border-r border-slate-300 bg-slate-100 px-2 py-1 text-left text-xs font-bold dark:border-slate-700 dark:bg-slate-800"
              >
                Swimmer
              </th>
              {meet.events.map((event, index) => {
                const count = (meet.entries[event.id] ?? []).length;
                return (
                  <th
                    key={event.id}
                    className="sticky top-0 z-20 border-b border-r border-slate-300 bg-slate-100 px-0.5 py-1 text-center text-[11px] font-bold leading-tight dark:border-slate-700 dark:bg-slate-800"
                    title={eventName(event)}
                  >
                    <span className="block text-slate-400">{index + 1}</span>
                    <span className="block">{event.distance}</span>
                    <span className="block">{event.stroke}</span>
                    <span
                      className={`block font-normal ${
                        event.gender === "Open"
                          ? "text-slate-400"
                          : "text-blue-600 dark:text-blue-400"
                      }`}
                    >
                      {event.gender === "Open" ? "—" : event.gender}
                    </span>
                    <span className="block font-normal text-slate-500">
                      {count}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {swimmers.map((swimmer) => (
              <tr key={swimmer.id}>
                <th
                  scope="row"
                  style={{ width: NAME_COL }}
                  className="sticky left-0 z-10 border-b border-r border-slate-300 bg-white px-2 py-1 text-left dark:border-slate-700 dark:bg-slate-900"
                >
                  <span className="block truncate text-sm font-semibold">
                    {shortName(swimmer)}
                  </span>
                  <span className="block text-[11px] font-normal text-slate-500">
                    {swimmer.gender}
                    {swimmer.year && ` · ${swimmer.year}`} ·{" "}
                    {perSwimmer.get(swimmer.id) ?? 0} ev
                  </span>
                </th>
                {meet.events.map((event) => {
                  const eligible = isEligible(swimmer, event);
                  const isIn = registered.has(`${event.id}|${swimmer.id}`);
                  return (
                    <td
                      key={event.id}
                      className="border-b border-r border-slate-300 p-0 dark:border-slate-700"
                    >
                      <button
                        type="button"
                        disabled={!eligible}
                        aria-pressed={isIn}
                        aria-label={`${shortName(swimmer)} in ${eventName(event)}`}
                        onClick={() => toggleEntry(meet.id, event.id, swimmer.id)}
                        className={`flex h-12 w-full touch-manipulation items-center justify-center text-xl font-bold transition-colors ${
                          !eligible
                            ? "cursor-not-allowed bg-slate-100 text-slate-300 dark:bg-slate-800/60 dark:text-slate-700"
                            : isIn
                              ? "bg-emerald-500 text-white active:bg-emerald-600"
                              : "bg-white text-transparent active:bg-slate-200 dark:bg-slate-900 dark:active:bg-slate-700"
                        }`}
                      >
                        {eligible ? "✓" : "·"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {swimmers.length === 0 && (
          <div className="px-4 pt-3">
            <EmptyState title="No swimmers match that search" />
          </div>
        )}
      </div>

      {adding && (
        <SwimmerSheet
          title="Add swimmer"
          onClose={() => setAdding(false)}
          onSave={(swimmer: Swimmer) => {
            addSwimmers([swimmer], "append");
            setAdding(false);
            setSearch("");
          }}
        />
      )}
    </div>
  );
}

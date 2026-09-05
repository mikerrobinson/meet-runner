import { useMemo, useState } from "react";
import { Sheet, TextInput } from "./ui";
import { allResults } from "~/lib/timing";
import {
  bySwimmer,
  displayName,
  eventName,
  isEligible,
  swimmerName,
  type Enrollment,
  type Heat,
  type MeetDoc,
  type NameOrder,
  type Swimmer,
} from "~/types/meet";

interface Candidate {
  swimmer: Swimmer;
  /** Where they already sit in this event, if anywhere. */
  seatedAt?: { heatNumber: number; lane: number };
  /** They've already swum this event, so they can't be moved into it again. */
  swum: boolean;
}

/**
 * Pick a swimmer for an empty lane, mid-meet. Choosing one seats them and
 * enters them in the event in a single step — for the swimmer who decides to
 * swim while walking up behind the blocks.
 */
export function LaneAssignSheet({
  meet,
  roster,
  enrollments,
  nameOrder,
  heat,
  lane,
  onAssign,
  onClose,
}: {
  meet: MeetDoc;
  /** This meet's season roster — anyone off it can't be entered. */
  roster: Swimmer[];
  /** Their year and squad this season, keyed by athlete id. */
  enrollments: Map<string, Enrollment>;
  nameOrder: NameOrder;
  heat: Heat;
  lane: number;
  onAssign: (swimmerId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const event = meet.events.find((e) => e.id === heat.eventId);

  const candidates = useMemo<Candidate[]>(() => {
    const heatsInEvent = meet.heats
      .filter((h) => h.eventId === heat.eventId)
      .sort((a, b) => a.index - b.index);

    const seats = new Map<string, { heatNumber: number; lane: number }>();
    for (const h of heatsInEvent) {
      h.lanes.forEach((id, i) => {
        if (id) seats.set(id, { heatNumber: h.index + 1, lane: i + 1 });
      });
    }

    const swum = new Set(
      allResults(meet)
        .filter((r) => r.eventId === heat.eventId)
        .map((r) => r.swimmerId),
    );

    const query = search.trim().toLowerCase();

    return roster
      .filter((s) => !event || isEligible(s, event))
      .filter((s) => !query || swimmerName(s).toLowerCase().includes(query))
      .map((s) => ({
        swimmer: s,
        seatedAt: seats.get(s.id),
        swum: swum.has(s.id),
      }))
      .sort((a, b) => {
        // Whoever isn't already in the event is nearly always who you're
        // reaching for, so float them to the top.
        const aFree = a.seatedAt ? 1 : 0;
        const bFree = b.seatedAt ? 1 : 0;
        if (aFree !== bFree) return aFree - bFree;
        return bySwimmer(nameOrder)(a.swimmer, b.swimmer);
      });
  }, [roster, nameOrder, meet, heat.eventId, event, search]);

  return (
    <Sheet open title={`Lane ${lane} · who's swimming?`} onClose={onClose}>
      {event && (
        <p className="-mt-2 mb-3 text-sm text-slate-500 dark:text-slate-400">
          They'll be entered in {eventName(event)} as well.
        </p>
      )}

      <TextInput
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search swimmers"
        autoFocus
      />

      {candidates.length === 0 ? (
        <p className="py-6 text-center text-slate-500">
          No eligible swimmers match that.
        </p>
      ) : (
        <ul className="mt-2 max-h-[45vh] divide-y divide-slate-200 overflow-y-auto overscroll-contain dark:divide-slate-800">
          {candidates.map(({ swimmer, seatedAt, swum }) => (
            <li key={swimmer.id}>
              <button
                type="button"
                disabled={swum}
                onClick={() => {
                  onAssign(swimmer.id);
                  onClose();
                }}
                className="flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 px-1 py-2 text-left disabled:opacity-40"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {displayName(swimmer, nameOrder)}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {swimmer.gender}
                    {enrollments.get(swimmer.id)?.year &&
                      ` · ${enrollments.get(swimmer.id)?.year}`}
                    {enrollments.get(swimmer.id)?.squad &&
                      ` · ${enrollments.get(swimmer.id)?.squad}`}
                  </span>
                </span>

                {swum ? (
                  <span className="shrink-0 rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    already swam
                  </span>
                ) : seatedAt ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    move from H{seatedAt.heatNumber} L{seatedAt.lane}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

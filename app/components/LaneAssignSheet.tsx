import { useMemo, useState } from "react";
import { Sheet, TextInput } from "./ui";
import { seedsForEvent, swimTime } from "~/lib/timing";
import {
  byAthlete,
  displayName,
  eventName,
  isEligible,
  athleteName,
  type Enrollment,
  type MeetDetail,
  type NameOrder,
  type Athlete,
} from "~/types/meet";

interface Candidate {
  athlete: Athlete;
  /** Where they already sit in this event, if anywhere. */
  seatedAt?: { heatNumber: number; lane: number };
  /** They've already swum this event, so they can't be moved into it again. */
  swum: boolean;
}

/**
 * Pick a athlete for an empty lane, mid-meet. Choosing one seats them and
 * enters them in the event in a single step — for the athlete who decides to
 * swim while walking up behind the blocks.
 */
export function LaneAssignSheet({
  detail,
  roster,
  enrollments,
  nameOrder,
  eventId,
  heat,
  lane,
  onAssign,
  onClose,
}: {
  detail: MeetDetail;
  /** This meet's season roster — anyone off it can't be entered. */
  roster: Athlete[];
  /** Their year and squad this season, keyed by athlete id. */
  enrollments: Map<string, Enrollment>;
  nameOrder: NameOrder;
  /** The lane being filled, as the meet numbers it. */
  eventId: string;
  heat: number;
  lane: number;
  onAssign: (athleteId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const event = detail.events.find((e) => e.id === eventId);

  const candidates = useMemo<Candidate[]>(() => {
    // Where everybody in this event already sits, so the picker can say
    // "already in heat 2, lane 4" rather than silently moving them.
    const seats = new Map<string, { heatNumber: number; lane: number }>();
    for (const seed of seedsForEvent(detail, eventId)) {
      seats.set(seed.athleteId, { heatNumber: seed.heat, lane: seed.lane });
    }

    // Anyone whose swim in this event already has a time. Moving them would
    // move the time with them.
    const swum = new Set(
      seedsForEvent(detail, eventId)
        .filter((seed) => swimTime(detail, seed.id) !== null)
        .map((seed) => seed.athleteId),
    );

    const query = search.trim().toLowerCase();

    return roster
      .filter((s) => !event || isEligible(s, event))
      .filter((s) => !query || athleteName(s).toLowerCase().includes(query))
      .map((s) => ({
        athlete: s,
        seatedAt: seats.get(s.id),
        swum: swum.has(s.id),
      }))
      .sort((a, b) => {
        // Whoever isn't already in the event is nearly always who you're
        // reaching for, so float them to the top.
        const aFree = a.seatedAt ? 1 : 0;
        const bFree = b.seatedAt ? 1 : 0;
        if (aFree !== bFree) return aFree - bFree;
        return byAthlete(nameOrder)(a.athlete, b.athlete);
      });
  }, [roster, nameOrder, detail, eventId, event, search]);

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
          {candidates.map(({ athlete, seatedAt, swum }) => (
            <li key={athlete.id}>
              <button
                type="button"
                disabled={swum}
                onClick={() => {
                  onAssign(athlete.id);
                  onClose();
                }}
                className="flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 px-1 py-2 text-left disabled:opacity-40"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {displayName(athlete, nameOrder)}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {athlete.gender}
                    {enrollments.get(athlete.id)?.year &&
                      ` · ${enrollments.get(athlete.id)?.year}`}
                    {enrollments.get(athlete.id)?.squad &&
                      ` · ${enrollments.get(athlete.id)?.squad}`}
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

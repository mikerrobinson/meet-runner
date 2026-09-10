import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { request } from "~/lib/http";
import type { MeetDoc } from "~/types/meet";

/**
 * What the person at this device may do in this meet.
 *
 * Answered by the server, because no single thing on the client can work it
 * out: running a meet lives in one table, coaching a team in another, and
 * being a swimmer in the objects. Screens ask this instead of assembling it
 * themselves, so there's one answer rather than four slightly different ones.
 *
 * It starts as "may look, may change nothing" and stays there if the request
 * fails. Read-only is the safe way to be wrong: a coach briefly seeing a
 * read-only screen is a moment's confusion, where the reverse is an editable
 * screen whose saves get refused.
 */
export interface MeetRole {
  /** Still asking. Screens can show what they have rather than blocking. */
  loading: boolean;
  signedIn: boolean;
  /** Runs the meet: the lineup, the seeding, the rulings, the sign-offs. */
  admin: boolean;
  /** Teams in this meet that this person coaches. */
  coachOf: string[];
  /** The roster entry this account is, if a coach has linked one. */
  athleteId: string | null;
}

const EMPTY: MeetRole = {
  loading: true,
  signedIn: false,
  admin: false,
  coachOf: [],
  athleteId: null,
};

const MeetRoleContext = createContext<MeetRole>(EMPTY);

export function MeetRoleProvider({
  meetId,
  children,
}: {
  meetId: string | undefined;
  children: ReactNode;
}) {
  const [role, setRole] = useState<MeetRole>(EMPTY);

  useEffect(() => {
    if (!meetId) return;
    let cancelled = false;
    setRole(EMPTY);

    request<Omit<MeetRole, "loading">>(
      `/api/meets/${encodeURIComponent(meetId)}/me`,
    )
      .then((body) => {
        if (!cancelled) setRole({ ...body, loading: false });
      })
      .catch(() => {
        // Offline on a deck is the common case, not an error. A coach who
        // holds the meet keeps working from local data; what they lose is the
        // editing chrome, which is the right thing to lose.
        if (!cancelled) setRole({ ...EMPTY, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [meetId]);

  return (
    <MeetRoleContext.Provider value={role}>{children}</MeetRoleContext.Provider>
  );
}

export function useMeetRole(): MeetRole {
  return useContext(MeetRoleContext);
}

/* ------------------------------------------------------------ what it means */

/** Only whoever runs the meet sets the lineup, the seeding and the sign-offs. */
export function canEditMeet(role: MeetRole): boolean {
  return role.admin;
}

/**
 * Whether this person may change a given swimmer's entries.
 *
 * An administrator may enter anybody. A coach may enter the swimmers on the
 * teams they coach. A swimmer may enter themselves, and only where the meet
 * has been set up to allow it — most coaches pick the lineup, and the ones who
 * hand it over say so deliberately.
 */
export function canEditEntriesFor(
  role: MeetRole,
  meet: Pick<MeetDoc, "options">,
  athleteId: string,
  athleteTeamId: string | null,
): boolean {
  if (role.admin) return true;
  if (athleteTeamId && role.coachOf.includes(athleteTeamId)) return true;
  return (
    meet.options.athletesMayEnter === true && role.athleteId === athleteId
  );
}

/** Whether there's any entry at all this person could change. */
export function canEditAnyEntries(
  role: MeetRole,
  meet: Pick<MeetDoc, "options">,
): boolean {
  if (role.admin || role.coachOf.length > 0) return true;
  return meet.options.athletesMayEnter === true && role.athleteId !== null;
}

/**
 * Whether the entries list may be shown at all.
 *
 * A meet set to `own-team` keeps each coach to their own lineup until the
 * racing starts — a lineup is competitive information before a meet and a
 * matter of record after it. Anyone running the meet always sees everything.
 */
export function canSeeEntries(
  role: MeetRole,
  meet: Pick<MeetDoc, "options">,
): boolean {
  if (meet.options.entryVisibility !== "own-team") return true;
  return role.admin || role.coachOf.length > 0 || role.athleteId !== null;
}

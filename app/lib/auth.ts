/**
 * The client half of signing in.
 *
 * Thin on purpose: every rule about codes and which team to open lives on the
 * server or in `identity.ts`, and this is only the shape of the conversation.
 */

import { request } from "./http";
import { saveSessionToken } from "./storage";

export interface SessionUser {
  id: string;
  contact: string;
  contactKind: string;
  name: string | null;
  lastSeasonId: string | null;
}

/** A team, as the session knows it: what it's called and how big it is. */
export interface SessionTeam {
  teamId: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
}

export interface JoinableTeam extends SessionTeam {
  /** False when nobody coaches it yet, which is what makes it claimable. */
  claimed: boolean;
}

export interface Session {
  user: SessionUser | null;
  /** The teams this person coaches. There is no other standing to have. */
  teams: SessionTeam[];
  openTeamId: string | null;
  joinable: JoinableTeam[];
}

/** A signed-out session, so callers never have to handle a null of their own. */
export const SIGNED_OUT: Session = {
  user: null,
  teams: [],
  openTeamId: null,
  joinable: [],
};

function normalize(body: Partial<Session>): Session {
  return {
    user: body.user ?? null,
    teams: body.teams ?? [],
    openTeamId: body.openTeamId ?? null,
    joinable: body.joinable ?? [],
  };
}

export interface CodeSent {
  kind: "email" | "phone";
  /** The canonical contact, which is what `verify` must be given back. */
  contact: string;
  masked: string;
  sent: boolean;
  detail?: string;
  /** Only ever present when the server is running with AUTH_DEV_CODES set. */
  code?: string;
}

export async function requestCode(contact: string): Promise<CodeSent> {
  return request("/api/auth/start", {
    method: "POST",
    body: JSON.stringify({ contact }),
  });
}

/**
 * Trade the code for a session, and remember it.
 *
 * Storing the token is part of this rather than left to the caller: it comes
 * back exactly once, and a caller that forgot to save it would have signed in
 * successfully and lost the result.
 */
export async function verifyCode(
  contact: string,
  code: string,
  invite?: string | null,
): Promise<
  Session & { isNew: boolean; inviteError?: string; invitedMeetId?: string }
> {
  const body = await request<
    Session & {
      token: string;
      isNew: boolean;
      inviteError?: string;
      invitedMeetId?: string;
    }
  >("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ contact, code, invite: invite || undefined }),
  });
  saveSessionToken(body.token);
  return {
    ...normalize(body),
    isNew: body.isNew,
    inviteError: body.inviteError,
    invitedMeetId: body.invitedMeetId,
  };
}

export async function readSession(): Promise<Session> {
  return normalize(await request<Partial<Session>>("/api/auth/session"));
}

export async function updateSession(patch: {
  name?: string;
  lastTeamId?: string;
  lastSeasonId?: string | null;
}): Promise<Session> {
  return normalize(
    await request<Partial<Session>>("/api/auth/session", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Forget this device's session.
 *
 * The token is cleared whatever the server says: a request that failed because
 * the token was already dead should still leave the device signed out, or
 * "sign out" would appear not to work in exactly the case it's needed.
 */
export async function signOut(everywhere = false): Promise<void> {
  try {
    await request(`/api/auth/session${everywhere ? "?everywhere" : ""}`, {
      method: "DELETE",
    });
  } finally {
    saveSessionToken("");
  }
}

/** Start a team, with yourself coaching it. */
export async function startTeam(
  name: string,
  code?: string,
): Promise<{ session: Session; teamId: string }> {
  const body = await request<{ team: { id: string } }>("/api/teams", {
    method: "POST",
    body: JSON.stringify({ name, code, coach: true }),
  });
  return { session: await readSession(), teamId: body.team.id };
}

/**
 * What a link is for. Two kinds, tagged, because they land you in different
 * places: a team invitation makes you a member, a meet invitation makes you
 * one of the people running that meet.
 */
export type InviteInfo =
  | { kind: "team"; teamId: string; name: string; code: string }
  | { kind: "meet"; meetId: string; name: string; date: string; contact: string };

/** What a link joins, read before anyone has signed in. */
export async function inspectInvite(token: string): Promise<InviteInfo> {
  return request(`/api/invites?token=${encodeURIComponent(token)}`);
}


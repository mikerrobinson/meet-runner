/**
 * The client half of signing in.
 *
 * Thin on purpose: every rule about codes, roles and which team to open lives
 * on the server or in `identity.ts`, and this is only the shape of the
 * conversation.
 */

import { request } from "./http";
import { saveSessionToken } from "./storage";
import type { MembershipStatus, Role } from "./identity";

export interface SessionUser {
  id: string;
  contact: string;
  contactKind: string;
  name: string | null;
  lastSeasonId: string | null;
}

export interface TeamMembership {
  teamId: string;
  role: Role;
  status: MembershipStatus;
  name: string;
  code: string;
  athletes: number;
  meets: number;
  requestedAt: number;
}

export interface JoinableTeam {
  teamId: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
  claimed: boolean;
  status?: MembershipStatus;
}

export interface Session {
  user: SessionUser | null;
  memberships: TeamMembership[];
  openTeamId: string | null;
  joinable: JoinableTeam[];
}

/** A signed-out session, so callers never have to handle a null of their own. */
export const SIGNED_OUT: Session = {
  user: null,
  memberships: [],
  openTeamId: null,
  joinable: [],
};

function normalize(body: Partial<Session>): Session {
  return {
    user: body.user ?? null,
    memberships: body.memberships ?? [],
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
): Promise<Session & { isNew: boolean; inviteError?: string }> {
  const body = await request<
    Session & { token: string; isNew: boolean; inviteError?: string }
  >("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ contact, code, invite: invite || undefined }),
  });
  saveSessionToken(body.token);
  return { ...normalize(body), isNew: body.isNew, inviteError: body.inviteError };
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

/**
 * Ask to join a team, or — with `create` — declare a team id as a new team of
 * your own. The second is how a coach with no team gets one: the id is minted
 * on the device, claimed here, and only then synced.
 */
export async function askToJoin(
  teamId: string,
  create = false,
): Promise<Session & { claimed: boolean }> {
  const body = await request<Session & { claimed: boolean }>("/api/memberships", {
    method: "POST",
    body: JSON.stringify({ teamId, create }),
  });
  return { ...normalize(body), claimed: body.claimed };
}

export interface PendingRequest {
  userId: string;
  contact: string;
  name: string | null;
  requestedAt: number;
}

export async function listPending(teamId: string): Promise<PendingRequest[]> {
  const body = await request<{ pending: PendingRequest[] }>(
    `/api/memberships?teamId=${encodeURIComponent(teamId)}`,
  );
  return body.pending;
}

export async function decideRequest(
  teamId: string,
  userId: string,
  admit: boolean,
  role?: Role,
): Promise<Session> {
  return normalize(
    await request<Partial<Session>>("/api/memberships", {
      method: "PATCH",
      body: JSON.stringify({ teamId, userId, admit, role }),
    }),
  );
}

export interface InviteInfo {
  teamId: string;
  role: Role;
  name: string;
  code: string;
}

/** What a link joins, read before anyone has signed in. */
export async function inspectInvite(token: string): Promise<InviteInfo> {
  return request(`/api/invites?token=${encodeURIComponent(token)}`);
}

export async function createInvite(
  teamId: string,
  role: Role,
): Promise<{ token: string; role: Role; url: string }> {
  return request("/api/invites", {
    method: "POST",
    body: JSON.stringify({ teamId, role }),
  });
}

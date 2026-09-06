/**
 * Accounts, sessions and team membership.
 *
 * The rules live in `identity.ts`; this is where they meet a database. Five
 * tables, all small: who exists, the code they were last sent, the sessions
 * they hold, which teams they belong to, and outstanding invites.
 *
 * Two things are stored hashed rather than plainly — session tokens and login
 * codes. Neither is a password, but both are live credentials for as long as
 * they last, and a hash means a copy of the database isn't a set of working
 * logins.
 */

import {
  CODE_TTL_MS,
  RESEND_INTERVAL_MS,
  checkChallenge,
  isCoach,
  newCode,
  normalizeCode,
  teamToOpen,
  timingSafeEqual,
  type ChallengeCheck,
  type Contact,
  type Membership,
  type MembershipStatus,
  type Role,
} from "./identity";
import { ensureObjectStore } from "./sync.server";

/**
 * `users.contact` is the identity, and is unique: signing in with a contact
 * nobody has used before is what creates an account, so there is no separate
 * sign-up and no way to end up with two accounts for one address.
 *
 * `login_codes` is keyed by contact rather than by user, because a code is
 * sent before we know — or care — whether the person behind it exists yet.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     contact TEXT NOT NULL UNIQUE,
     contact_kind TEXT NOT NULL,
     name TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     last_team_id TEXT,
     last_season_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS login_codes (
     contact TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS memberships (
     team_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     decided_at INTEGER,
     decided_by TEXT,
     PRIMARY KEY (team_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships (user_id)`,
  `CREATE TABLE IF NOT EXISTS invites (
     token_hash TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     role TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     used_by TEXT
   )`,
];

let ready = false;

export async function ensureAuthStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

/* ------------------------------------------------------------- primitives */

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Codes are hashed with the contact mixed in.
 *
 * Six digits is a small enough space that a bare hash is a lookup table; the
 * contact makes each one its own space, which is all that's needed given the
 * ten-minute life and five-guess limit.
 */
function codeHash(contact: string, code: string): Promise<string> {
  return sha256(`code:${contact}:${code}`);
}

function tokenHash(token: string): Promise<string> {
  return sha256(`token:${token}`);
}

/** 256 bits, URL-safe — it travels in a header and sometimes in a link. */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function newId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------- challenges */

export type ChallengeStart =
  | { ok: true; code: string }
  | { ok: false; retryInMs: number };

/**
 * Mint a code for a contact, replacing whatever was outstanding.
 *
 * One live challenge per contact: asking again should get you a working code,
 * not a choice of two. The quiet period in between is what stops the endpoint
 * being used to text a stranger over and over.
 */
export async function startChallenge(
  db: D1Database,
  contact: Contact,
  now = Date.now(),
): Promise<ChallengeStart> {
  await ensureAuthStore(db);

  const existing = await db
    .prepare("SELECT created_at FROM login_codes WHERE contact = ?")
    .bind(contact.value)
    .first<{ created_at: number }>();

  if (existing && now - existing.created_at < RESEND_INTERVAL_MS) {
    return { ok: false, retryInMs: RESEND_INTERVAL_MS - (now - existing.created_at) };
  }

  const code = newCode();
  await db
    .prepare(
      `INSERT INTO login_codes (contact, code_hash, created_at, attempts)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(contact) DO UPDATE SET
         code_hash = excluded.code_hash,
         created_at = excluded.created_at,
         attempts = 0`,
    )
    .bind(contact.value, await codeHash(contact.value, code), now)
    .run();

  return { ok: true, code };
}

export type VerifyResult =
  | { ok: true; user: User; isNew: boolean }
  | { ok: false; check: ChallengeCheck };

/**
 * Check a code and, if it holds, produce the person behind the contact.
 *
 * A contact nobody has used before becomes an account here — proving you can
 * read what was sent to it is the entire signup. A wrong guess costs an
 * attempt; a right one burns the challenge outright so a code can't be
 * replayed.
 */
export async function verifyChallenge(
  db: D1Database,
  contact: Contact,
  submitted: string,
  now = Date.now(),
): Promise<VerifyResult> {
  await ensureAuthStore(db);

  const row = await db
    .prepare("SELECT code_hash, created_at, attempts FROM login_codes WHERE contact = ?")
    .bind(contact.value)
    .first<{ code_hash: string; created_at: number; attempts: number }>();

  // No challenge at all reads as expired: it's the same situation from the
  // person's side, and saying "never asked" would confirm the contact exists.
  if (!row) return { ok: false, check: { ok: false, reason: "expired" } };

  const submittedHash = await codeHash(contact.value, normalizeCode(submitted));
  const check = checkChallenge(
    { createdAt: row.created_at, attempts: row.attempts },
    timingSafeEqual(row.code_hash, submittedHash),
    now,
  );

  if (!check.ok) {
    if (check.reason === "wrong") {
      await db
        .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE contact = ?")
        .bind(contact.value)
        .run();
    }
    return { ok: false, check };
  }

  await db.prepare("DELETE FROM login_codes WHERE contact = ?").bind(contact.value).run();

  const existing = await findUser(db, contact.value);
  if (existing) {
    await db
      .prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
      .bind(now, existing.id)
      .run();
    return { ok: true, user: { ...existing, lastSeenAt: now }, isNew: false };
  }

  const user: User = {
    id: newId(),
    contact: contact.value,
    contactKind: contact.kind,
    name: null,
    createdAt: now,
    lastSeenAt: now,
    lastTeamId: null,
    lastSeasonId: null,
  };
  await db
    .prepare(
      `INSERT INTO users (id, contact, contact_kind, name, created_at, last_seen_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .bind(user.id, user.contact, user.contactKind, now, now)
    .run();

  return { ok: true, user, isNew: true };
}

/** Sweep expired codes and sessions. Cheap, and called on sign-in. */
export async function tidy(db: D1Database, now = Date.now()): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare("DELETE FROM login_codes WHERE created_at < ?")
    .bind(now - CODE_TTL_MS)
    .run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
}

/* ---------------------------------------------------------------- sessions */

/**
 * How long a session lasts without being used.
 *
 * Long, on purpose: a coach signs in once on the iPad that lives in the swim
 * bag and shouldn't be asked again mid-meet on pool wifi. Every use pushes it
 * out again, so in practice only a device that's been idle for over a year
 * has to sign in twice.
 */
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/** Don't rewrite the row on every request — a day's resolution is plenty. */
const SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  contact: string;
  contactKind: string;
  name: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastTeamId: string | null;
  lastSeasonId: string | null;
}

interface UserRow {
  id: string;
  contact: string;
  contact_kind: string;
  name: string | null;
  created_at: number;
  last_seen_at: number;
  last_team_id: string | null;
  last_season_id: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    contact: row.contact,
    contactKind: row.contact_kind,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastTeamId: row.last_team_id,
    lastSeasonId: row.last_season_id,
  };
}

const USER_COLUMNS =
  "id, contact, contact_kind, name, created_at, last_seen_at, last_team_id, last_season_id";

async function findUser(db: D1Database, contact: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE contact = ?`)
    .bind(contact)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

/** Hand out a session. The plaintext token is returned once and never stored. */
export async function createSession(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<string> {
  await ensureAuthStore(db);
  const token = newToken();
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await tokenHash(token), userId, now, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/**
 * The person behind a token, or null.
 *
 * Looked up by hash, so an expired or forged token is simply a miss — there's
 * no branch here that behaves differently for a token that once existed.
 */
export async function userForToken(
  db: D1Database,
  token: string | null | undefined,
  now = Date.now(),
): Promise<User | null> {
  if (!token) return null;
  await ensureAuthStore(db);

  const hash = await tokenHash(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.contact, u.contact_kind, u.name, u.created_at, u.last_seen_at,
              u.last_team_id, u.last_season_id, s.last_used_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(hash, now)
    .first<UserRow & { last_used_at: number }>();
  if (!row) return null;

  // Sliding expiry, written at most once a day so a busy meet doesn't turn
  // every request into a write.
  if (now - row.last_used_at > SESSION_TOUCH_MS) {
    await db
      .prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?")
      .bind(now, now + SESSION_TTL_MS, hash)
      .run();
  }

  return toUser(row);
}

/** The bearer token on a request, from the header the client sends. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

export async function endSession(db: D1Database, token: string): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await tokenHash(token))
    .run();
}

/** Sign out everywhere — the answer to a lost phone. */
export async function endAllSessions(db: D1Database, userId: string): Promise<void> {
  await ensureAuthStore(db);
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function setName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<void> {
  await ensureAuthStore(db);
  const trimmed = name.trim().slice(0, 80);
  await db
    .prepare("UPDATE users SET name = ? WHERE id = ?")
    .bind(trimmed || null, userId)
    .run();
}

/**
 * Remember where someone was.
 *
 * On the user rather than the device, so signing in on the phone at the pool
 * opens the same team and season the laptop was left on — and off the team
 * document, which is shared and has no business carrying one person's view.
 */
export async function setLastPlace(
  db: D1Database,
  userId: string,
  teamId: string,
  seasonId: string | null,
): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare("UPDATE users SET last_team_id = ?, last_season_id = ? WHERE id = ?")
    .bind(teamId, seasonId, userId)
    .run();
}

/* ------------------------------------------------------------- membership */

export interface TeamMembership extends Membership {
  name: string;
  code: string;
  athletes: number;
  meets: number;
  requestedAt: number;
}

/** Name and size of each team, read from the synced objects. */
async function teamFacts(
  db: D1Database,
): Promise<Map<string, { name: string; code: string; athletes: number; meets: number }>> {
  // The teams are whatever the object store holds; auth doesn't keep its own
  // copy of a team, so there's nothing here that can disagree with the roster.
  await ensureObjectStore(db);
  const { results } = await db
    .prepare(
      `SELECT team_id,
              SUM(CASE WHEN type = 'athlete' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS athletes,
              SUM(CASE WHEN type = 'meet'    AND deleted_at IS NULL THEN 1 ELSE 0 END) AS meets,
              MAX(CASE WHEN type = 'team' AND deleted_at IS NULL THEN data END) AS team_data
       FROM objects GROUP BY team_id`,
    )
    .all<{ team_id: string; athletes: number; meets: number; team_data: string | null }>();

  const facts = new Map<string, { name: string; code: string; athletes: number; meets: number }>();
  for (const row of results) {
    const parsed = row.team_data
      ? (JSON.parse(row.team_data) as { name?: string; code?: string })
      : null;
    facts.set(row.team_id, {
      name: parsed?.name ?? "Untitled team",
      code: parsed?.code ?? "",
      athletes: row.athletes,
      meets: row.meets,
    });
  }
  return facts;
}

/** Every team this person belongs to or has asked to join. */
export async function membershipsFor(
  db: D1Database,
  userId: string,
): Promise<TeamMembership[]> {
  await ensureAuthStore(db);

  const { results } = await db
    .prepare(
      `SELECT team_id, role, status, created_at FROM memberships
       WHERE user_id = ? ORDER BY created_at`,
    )
    .bind(userId)
    .all<{ team_id: string; role: Role; status: MembershipStatus; created_at: number }>();
  if (results.length === 0) return [];

  const facts = await teamFacts(db);
  return results.map((row) => ({
    teamId: row.team_id,
    role: row.role,
    status: row.status,
    requestedAt: row.created_at,
    ...(facts.get(row.team_id) ?? {
      name: "Untitled team",
      code: "",
      athletes: 0,
      meets: 0,
    }),
  }));
}

export async function membershipIn(
  db: D1Database,
  userId: string,
  teamId: string,
): Promise<Membership | undefined> {
  await ensureAuthStore(db);
  const row = await db
    .prepare("SELECT team_id, role, status FROM memberships WHERE user_id = ? AND team_id = ?")
    .bind(userId, teamId)
    .first<{ team_id: string; role: Role; status: MembershipStatus }>();
  return row ? { teamId: row.team_id, role: row.role, status: row.status } : undefined;
}

/** Whether anyone at all is an active member — i.e. whether it's spoken for. */
export async function isTeamClaimed(
  db: D1Database,
  teamId: string,
): Promise<boolean> {
  await ensureAuthStore(db);
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS active FROM memberships WHERE team_id = ? AND status = 'active'",
    )
    .bind(teamId)
    .first<{ active: number }>();
  return (row?.active ?? 0) > 0;
}

/**
 * Whether this caller may work with this team's data at all.
 *
 * One question, not a permission matrix. Members get the season; everyone else
 * gets nothing. What a member may *do* once they have it is decided by the
 * app — a viewer simply isn't shown the buttons — because the risk worth
 * spending code on here is disclosure, not a signed-in coach misbehaving.
 *
 * The unclaimed case keeps every season that predates accounts working until
 * someone claims it. Claiming is therefore the act that closes a team.
 */
export async function canUseTeam(
  db: D1Database,
  userId: string | null,
  teamId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [claimed, membership] = await Promise.all([
    isTeamClaimed(db, teamId),
    userId ? membershipIn(db, userId, teamId) : Promise.resolve(undefined),
  ]);

  if (!claimed || membership?.status === "active") return { ok: true };
  if (membership?.status === "pending") {
    return {
      ok: false,
      reason: "You've asked to join this team. A coach has to let you in.",
    };
  }
  return {
    ok: false,
    reason: userId ? "You're not on this team." : "Sign in to see this team.",
  };
}

export interface JoinableTeam {
  teamId: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
  /** False when no one has claimed the team yet — see `requestToJoin`. */
  claimed: boolean;
  /** This person's standing with it, if they have one. */
  status?: MembershipStatus;
}

/**
 * Teams a person could ask to join.
 *
 * Names and sizes only. That's deliberately more than nothing — you have to be
 * able to recognise your own team in the list — and deliberately not the
 * roster, which is the thing membership is for.
 */
export async function joinableTeams(
  db: D1Database,
  userId: string,
): Promise<JoinableTeam[]> {
  await ensureAuthStore(db);

  const facts = await teamFacts(db);
  const { results: claims } = await db
    .prepare(
      `SELECT team_id, COUNT(*) AS active FROM memberships
       WHERE status = 'active' GROUP BY team_id`,
    )
    .all<{ team_id: string; active: number }>();
  const claimed = new Map(claims.map((row) => [row.team_id, row.active > 0]));

  const mine = new Map(
    (await membershipsFor(db, userId)).map((m) => [m.teamId, m.status] as const),
  );

  return [...facts.entries()]
    .map(([teamId, fact]) => ({
      teamId,
      ...fact,
      claimed: claimed.get(teamId) ?? false,
      status: mine.get(teamId),
    }))
    .sort((a, b) => b.athletes - a.athletes || a.name.localeCompare(b.name));
}

export type JoinResult =
  | { ok: true; membership: Membership; claimed: boolean }
  | { ok: false; error: string };

/**
 * Ask to join a team — or take it over, if nobody holds it yet.
 *
 * The second case is the bootstrap. Teams that predate accounts have no
 * members at all, and somebody has to become their first coach; the first
 * person to ask does, and from then on the team is claimed and everyone else
 * waits for approval. It's a land grab of exactly one team, once, and it's the
 * only way in that doesn't require someone already being inside.
 */
export async function requestToJoin(
  db: D1Database,
  userId: string,
  teamId: string,
  now = Date.now(),
): Promise<JoinResult> {
  await ensureAuthStore(db);

  const existing = await membershipIn(db, userId, teamId);
  if (existing) {
    return existing.status === "active"
      ? { ok: false, error: "You're already on that team." }
      : { ok: false, error: "You've already asked to join. A coach has to approve it." };
  }

  const facts = await teamFacts(db);
  if (!facts.has(teamId)) return { ok: false, error: "No such team." };

  const held = await db
    .prepare(
      "SELECT COUNT(*) AS active FROM memberships WHERE team_id = ? AND status = 'active'",
    )
    .bind(teamId)
    .first<{ active: number }>();

  const unclaimed = (held?.active ?? 0) === 0;
  const membership: Membership = {
    teamId,
    role: unclaimed ? "head_coach" : "viewer",
    status: unclaimed ? "active" : "pending",
  };

  await db
    .prepare(
      `INSERT INTO memberships (team_id, user_id, role, status, created_at, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      teamId,
      userId,
      membership.role,
      membership.status,
      now,
      unclaimed ? now : null,
      unclaimed ? userId : null,
    )
    .run();

  return { ok: true, membership, claimed: unclaimed };
}

/**
 * Take ownership of a team id that doesn't exist on the server yet.
 *
 * A brand-new coach starting a brand-new team is the one case where the
 * ownership has to come first: the team itself only appears on the server
 * after the device syncs, and if the id were unowned until then, whoever
 * synced next could claim it. Minting the membership against the id the device
 * has already generated closes that window.
 */
export async function claimNewTeam(
  db: D1Database,
  userId: string,
  teamId: string,
  now = Date.now(),
): Promise<JoinResult> {
  await ensureAuthStore(db);

  const taken = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE team_id = ?")
    .bind(teamId)
    .first<{ n: number }>();
  if ((taken?.n ?? 0) > 0) {
    return { ok: false, error: "That team already has members." };
  }
  if ((await teamFacts(db)).has(teamId)) {
    return { ok: false, error: "That team already exists — ask to join it instead." };
  }

  await db
    .prepare(
      `INSERT INTO memberships (team_id, user_id, role, status, created_at, decided_at, decided_by)
       VALUES (?, ?, 'head_coach', 'active', ?, ?, ?)`,
    )
    .bind(teamId, userId, now, now, userId)
    .run();

  return {
    ok: true,
    membership: { teamId, role: "head_coach", status: "active" },
    claimed: true,
  };
}

export interface PendingRequest {
  userId: string;
  contact: string;
  name: string | null;
  requestedAt: number;
}

/** Who's waiting to be let into a team. */
export async function pendingRequests(
  db: D1Database,
  teamId: string,
): Promise<PendingRequest[]> {
  await ensureAuthStore(db);
  const { results } = await db
    .prepare(
      `SELECT m.user_id, m.created_at, u.contact, u.name
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? AND m.status = 'pending'
       ORDER BY m.created_at`,
    )
    .bind(teamId)
    .all<{ user_id: string; created_at: number; contact: string; name: string | null }>();

  return results.map((row) => ({
    userId: row.user_id,
    contact: row.contact,
    name: row.name,
    requestedAt: row.created_at,
  }));
}

/** Let someone in with a role, or turn them down. Coaches only — checked by
 *  the caller, which is the one that knows who's asking. */
export async function decideRequest(
  db: D1Database,
  teamId: string,
  userId: string,
  decision: { admit: boolean; role?: Role; by: string },
  now = Date.now(),
): Promise<void> {
  await ensureAuthStore(db);
  if (!decision.admit) {
    await db
      .prepare("DELETE FROM memberships WHERE team_id = ? AND user_id = ? AND status = 'pending'")
      .bind(teamId, userId)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE memberships SET status = 'active', role = ?, decided_at = ?, decided_by = ?
       WHERE team_id = ? AND user_id = ?`,
    )
    .bind(decision.role ?? "viewer", now, decision.by, teamId, userId)
    .run();
}

export async function removeMember(
  db: D1Database,
  teamId: string,
  userId: string,
): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare("DELETE FROM memberships WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .run();
}

/* --------------------------------------------------------------- invites */

/** An invite is good for a fortnight — long enough to sit in an inbox over a
 *  school holiday, short enough that a forwarded link goes stale. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Mint a one-time invite to a team.
 *
 * Returned in plaintext once, exactly like a session token, because it *is*
 * one — a bearer credential that turns into membership for whoever redeems it.
 * That's the trade for letting a coach add another coach by sending a link.
 */
export async function createInvite(
  db: D1Database,
  teamId: string,
  role: Role,
  createdBy: string,
  now = Date.now(),
): Promise<string> {
  await ensureAuthStore(db);
  const token = newToken();
  await db
    .prepare(
      `INSERT INTO invites (token_hash, team_id, role, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(await tokenHash(token), teamId, role, createdBy, now, now + INVITE_TTL_MS)
    .run();
  return token;
}

export interface InviteInfo {
  teamId: string;
  role: Role;
  name: string;
  code: string;
}

/** What an invite is for, before anyone signs in — so the sign-in screen can
 *  say which team is being joined instead of asking for a contact blind. */
export async function inspectInvite(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<InviteInfo | null> {
  await ensureAuthStore(db);
  const row = await db
    .prepare(
      `SELECT team_id, role FROM invites
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(await tokenHash(token), now)
    .first<{ team_id: string; role: Role }>();
  if (!row) return null;

  const facts = (await teamFacts(db)).get(row.team_id);
  return {
    teamId: row.team_id,
    role: row.role,
    name: facts?.name ?? "Untitled team",
    code: facts?.code ?? "",
  };
}

/**
 * Turn an invite into membership.
 *
 * The update that marks it used carries `used_at IS NULL` in its WHERE, so two
 * people racing on a forwarded link can't both come out members — whoever's
 * write lands second sees no rows changed and is told the invite is spent.
 */
export async function redeemInvite(
  db: D1Database,
  token: string,
  userId: string,
  now = Date.now(),
): Promise<{ ok: true; membership: Membership } | { ok: false; error: string }> {
  await ensureAuthStore(db);
  const hash = await tokenHash(token);

  const claimed = await db
    .prepare(
      `UPDATE invites SET used_at = ?, used_by = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       RETURNING team_id, role`,
    )
    .bind(now, userId, hash, now)
    .first<{ team_id: string; role: Role }>();

  if (!claimed) return { ok: false, error: "That invitation has expired or been used." };

  // An existing member keeps whatever they already had if it reaches further;
  // an invite should never quietly demote a coach who follows one.
  const existing = await membershipIn(db, userId, claimed.team_id);
  const role: Role =
    existing?.status === "active" && rank(existing.role) >= rank(claimed.role)
      ? existing.role
      : claimed.role;

  await db
    .prepare(
      `INSERT INTO memberships (team_id, user_id, role, status, created_at, decided_at, decided_by)
       VALUES (?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET
         role = excluded.role, status = 'active', decided_at = excluded.decided_at`,
    )
    .bind(claimed.team_id, userId, role, now, now, userId)
    .run();

  return { ok: true, membership: { teamId: claimed.team_id, role, status: "active" } };
}

/* ------------------------------------------------------------- the answer */

export interface SessionPayload {
  user: {
    id: string;
    contact: string;
    contactKind: string;
    name: string | null;
    lastSeasonId: string | null;
  };
  memberships: TeamMembership[];
  /** Which team to open. Null means there's nothing this person can open yet. */
  openTeamId: string | null;
  /** Teams to offer, and only when there's no team to open. */
  joinable: JoinableTeam[];
}

/**
 * Everything the app needs to draw itself for a signed-in person.
 *
 * One shape, returned by both signing in and asking "who am I", so the client
 * has a single thing to handle rather than two that could drift.
 *
 * `joinable` is filled in only when there's nothing to open. Somebody already
 * on a team has no business being handed a list of the others.
 */
export async function sessionPayload(
  db: D1Database,
  user: User,
  invitedTeamId?: string | null,
): Promise<SessionPayload> {
  const memberships = await membershipsFor(db, user.id);
  const openTeamId = teamToOpen(memberships, {
    invitedTeamId,
    lastTeamId: user.lastTeamId,
  });

  return {
    user: {
      id: user.id,
      contact: user.contact,
      contactKind: user.contactKind,
      name: user.name,
      lastSeasonId: user.lastSeasonId,
    },
    memberships,
    openTeamId,
    joinable: openTeamId ? [] : await joinableTeams(db, user.id),
  };
}

/** Only used to stop an invite demoting someone. Not a permission model. */
function rank(role: Role): number {
  if (role === "head_coach") return 3;
  if (isCoach(role)) return 2;
  if (role === "viewer") return 0;
  return 1;
}

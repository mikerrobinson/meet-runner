/**
 * Letting timers in without asking them who they are.
 *
 * A timer standing behind a lane gives no email, no phone, no name — exactly
 * as they give nothing today when handed a stopwatch and a clipboard. What
 * they get instead is a link, printed as a QR code and taped to the timing
 * table: holding it is the whole credential.
 *
 * That is a bearer token on a piece of paper on a pool deck, and it is meant
 * to be. The trade is deliberate, and the blast radius is kept small in three
 * ways: a grant is scoped to one meet, it can only write times, and it stops
 * working the day after that meet.
 */

import { pushObjects } from "./sync.server";
import type { SyncObject } from "./objects";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meet_grants (
     token_hash TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS grants_by_meet ON meet_grants (meet_id)`,
];

let ready = false;

export async function ensureGrantStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`grant:${token}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Short enough to be a QR code that scans from a metre away on a wet phone,
 * long enough not to be guessable. 15 bytes is 20 base64 characters.
 */
function newToken(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * When a meet's grant stops working.
 *
 * The meet's date, plus two days, at UTC midnight. That sounds sloppier than
 * it is: the app never learns anyone's timezone, and a naive "midnight on the
 * meet date" would expire an Arizona meet at five in the afternoon — mid-meet,
 * which is the worst moment available. Two days is the smallest number that is
 * safe everywhere on earth, and still means a photograph of the QR code in
 * someone's camera roll is worthless within about a day and a half.
 *
 * The floor is there because the meet's date alone produced codes that were
 * born expired. Print one for last month's meet — to collect times a timer
 * never managed to send, which is exactly when you'd want to — and you got a
 * QR code that simply didn't work, with nothing on screen to say why. Anything
 * issued now lasts at least until tomorrow, whatever the meet's date says.
 */
const MINIMUM_LIFE_MS = 12 * 60 * 60 * 1000;

export function grantExpiry(meetDate: string, now = Date.now()): number {
  const midnight = Date.parse(`${meetDate}T00:00:00Z`);
  const base = Number.isFinite(midnight) ? midnight : now;
  return Math.max(base + 2 * 24 * 60 * 60 * 1000, now + MINIMUM_LIFE_MS);
}

/**
 * Issue a grant for a meet, retiring any that came before it.
 *
 * Issuing is therefore also how you revoke: a coach who thinks the code has
 * got out taps the same button, the QR on the table stops working, and they
 * print a new one. There is nothing else to explain.
 */
export async function issueGrant(
  db: D1Database,
  meet: { id: string; teamId: string; date: string },
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  await ensureGrantStore(db);
  await db
    .prepare(
      "UPDATE meet_grants SET revoked_at = ? WHERE meet_id = ? AND revoked_at IS NULL",
    )
    .bind(now, meet.id)
    .run();

  const token = newToken();
  const expiresAt = grantExpiry(meet.date, now);
  await db
    .prepare(
      `INSERT INTO meet_grants (token_hash, meet_id, team_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await hash(token), meet.id, meet.teamId, now, expiresAt)
    .run();

  return { token, expiresAt };
}

export interface Grant {
  meetId: string;
  teamId: string;
  expiresAt: number;
}

/** The meet a token opens, or null. Expired and revoked are both just null. */
export async function grantFor(
  db: D1Database,
  token: string | null | undefined,
  now = Date.now(),
): Promise<Grant | null> {
  if (!token) return null;
  await ensureGrantStore(db);
  const row = await db
    .prepare(
      `SELECT meet_id, team_id, expires_at FROM meet_grants
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(await hash(token), now)
    .first<{ meet_id: string; team_id: string; expires_at: number }>();

  return row
    ? { meetId: row.meet_id, teamId: row.team_id, expiresAt: row.expires_at }
    : null;
}

/** Whether a meet currently has a working grant, for the coach's screen. */
export async function activeGrant(
  db: D1Database,
  meetId: string,
  now = Date.now(),
): Promise<{ expiresAt: number } | null> {
  await ensureGrantStore(db);
  const row = await db
    .prepare(
      `SELECT expires_at FROM meet_grants
       WHERE meet_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(meetId, now)
    .first<{ expires_at: number }>();
  return row ? { expiresAt: row.expires_at } : null;
}

export async function revokeGrants(
  db: D1Database,
  meetId: string,
  now = Date.now(),
): Promise<void> {
  await ensureGrantStore(db);
  await db
    .prepare(
      "UPDATE meet_grants SET revoked_at = ? WHERE meet_id = ? AND revoked_at IS NULL",
    )
    .bind(now, meetId)
    .run();
}

/**
 * Write objects on a timer's behalf, refusing anything outside their grant.
 *
 * The check is here rather than in the route because it is the only thing
 * standing between a bearer token taped to a table and the rest of a season.
 * Two kinds of object, and nothing else: a time, and a person to attach it to.
 * A timer cannot touch the running order, the entries, the heats, or a coach's
 * rulings, whatever they send.
 */
export async function writeAsTimer(
  db: D1Database,
  grant: Grant,
  objects: SyncObject[],
): Promise<{ applied: number }> {
  const allowed = objects.filter((object) => {
    if (object.teamId !== grant.teamId) return false;
    if (object.deletedAt) return false;
    if (object.type === "athlete") return true;
    if (object.type !== "watch") return false;
    return (object.data as { meetId?: string })?.meetId === grant.meetId;
  });

  if (allowed.length !== objects.length) {
    throw new Error("A timer may only record times and add swimmers");
  }
  const { applied } = await pushObjects(db, allowed);
  return { applied };
}

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

import { SyncError } from "./api.server";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meet_grants (
     token_hash TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
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
  meet: { id: string; date: string },
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
      `INSERT INTO meet_grants (token_hash, meet_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(await hash(token), meet.id, now, expiresAt)
    .run();

  return { token, expiresAt };
}

/* ----------------------------------------------------------------- cookie */

export const GRANT_COOKIE = "mr_timer";

/**
 * The grant on a request.
 *
 * A cookie, and only a cookie. The token arrives once, in the URL of a scanned
 * QR code, and `/t/:token` trades it for this before anything renders — so
 * from then on the browser carries the credential on every request without
 * any script being involved. That is what makes timing work on a phone the
 * app has never met: no storage to be blocked, nothing to hydrate, and no
 * state that a private window can refuse to keep.
 */
export function grantToken(request: Request): string | null {
  const jar = request.headers.get("cookie");
  if (!jar) return null;
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GRANT_COOKIE && rest.length) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

/**
 * How the grant cookie is written and cleared.
 *
 * `HttpOnly` because nothing on the page has any use for the token — the
 * whole point is that the browser sends it and no script ever holds it, which
 * also means a scripted page cannot leak it. Scoped to the app's own path
 * rather than the host, because a bearer credential taped to a table should
 * travel no further than the thing it opens.
 *
 * The lifetime is the grant's own: the cookie dies the moment the token it
 * carries stops working, so a phone is never holding a credential that
 * outlives what it was for.
 */
export function grantCookie(
  token: string | null,
  request: Request,
  options: { path: string; expiresAt?: number; now?: number },
): string {
  const now = options.now ?? Date.now();
  const https = new URL(request.url).protocol === "https:";
  const maxAge =
    token && options.expiresAt
      ? Math.max(0, Math.floor((options.expiresAt - now) / 1000))
      : 0;

  return [
    `${GRANT_COOKIE}=${token ? encodeURIComponent(token) : ""}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/* -------------------------------------------------------------- device id */

export const DEVICE_COOKIE = "mr_timer_id";

/**
 * Who this phone says it is, if it has been here before.
 *
 * `null` for a browser carrying no device cookie, which the callers treat as
 * something to put right rather than as an answer — see `deviceId`.
 */
export function existingDeviceId(request: Request): string | null {
  const jar = request.headers.get("cookie") ?? "";
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEVICE_COOKIE && rest.length) {
      const existing = decodeURIComponent(rest.join("=")).trim();
      if (/^[A-Za-z0-9_-]{1,40}$/.test(existing)) return existing;
    }
  }
  return null;
}

/**
 * Who this phone is when it takes a time.
 *
 * Minted at the moment the code is scanned and kept in a cookie from then on,
 * so it rides every request by itself. It used to be a segment of the URL as
 * well — `/meets/{meetId}/timers/{timerId}/…` — which meant the identity a
 * watch was filed under was whatever the address bar said, while the cookie
 * that actually travels with the phone sat there unread.
 *
 * Re-used whenever the phone already has one, which is the whole point. A
 * volunteer who scans again after lunch, or whose tab reloaded, must come back
 * as the *same* timer: watches are keyed by it, so a device that forgets files
 * a second watch on a lane it already timed, and since several watches on a
 * lane are averaged, that moves the time the desk reads. Every caller that
 * mints one here sets the cookie on the way out for that reason.
 *
 * Not `HttpOnly` — the coach's own deck stopwatch reads the same cookie for
 * the same purpose, and it identifies a device rather than authorising one.
 * The grant is the credential, and that one no script can touch.
 */
export function deviceId(request: Request): string {
  // URL-safe, for the sake of anything that still puts it in one.
  return (
    existingDeviceId(request) ?? `d-${Math.random().toString(36).slice(2, 10)}`
  );
}

/**
 * The app's own base path, taken from the URL a request arrived on.
 *
 * `/` in dev and `/` in production, with no config to
 * keep in step — the caller passes the known suffix it was reached at and
 * what's left in front of it is the base. It is what scopes the cookies, so
 * getting it wrong means a second cookie of the same name at a different path
 * and a device that answers to two ids.
 */
export function appBaseOf(request: Request, suffix: string): string {
  const { pathname } = new URL(request.url);
  const at = pathname.lastIndexOf(suffix);
  return at < 0 ? "/" : pathname.slice(0, at + 1);
}

export function deviceCookie(
  id: string,
  request: Request,
  path: string,
): string {
  const https = new URL(request.url).protocol === "https:";
  return [
    `${DEVICE_COOKIE}=${encodeURIComponent(id)}`,
    `Path=${path}`,
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
    `Max-Age=${60 * 60 * 24 * 365}`,
  ].join("; ");
}

export interface Grant {
  meetId: string;
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
      `SELECT meet_id, expires_at FROM meet_grants
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(await hash(token), now)
    .first<{ meet_id: string; expires_at: number }>();

  return row ? { meetId: row.meet_id, expiresAt: row.expires_at } : null;
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
 * Two kinds of object, and nothing else: a time in this meet, and a person to
 * attach it to. A timer cannot touch the running order, the entries, the
 * heats, or a coach's rulings, whatever they send.
 */

/**
 * Which of the athletes in a batch the server has never seen.
 *
 * A timer may introduce a person; they may not edit one. The difference is
 * whether the id already exists, so it's a lookup rather than a judgement.
 */

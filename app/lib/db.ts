/**
 * On-device storage.
 *
 * A season of meets outgrows localStorage — roughly 150KB per meet against a
 * ~5MB ceiling, and Safari's failure mode is a thrown quota error mid-write,
 * which on a pool deck means losing times. IndexedDB has no practical ceiling
 * here, at the cost of an async API.
 */

import { normalizeAthlete, parseMeetDoc, parseTeamDoc } from "./documents";
import type { SyncObject } from "./objects";
import type { MeetDoc, Athlete, TeamDoc } from "~/types/meet";

const DB_NAME = "meet-runner";
const DB_VERSION = 1;
const TEAM_STORE = "team";
const MEET_STORE = "meets";
/**
 * Sync bookkeeping lives in the team store under its own keys rather than in
 * a store of its own.
 *
 * Adding a store means bumping the database version, and a version upgrade
 * can't proceed while any other tab holds the old one open — which on a deck
 * full of devices is a hang with no explanation. Not needing the upgrade is
 * worth more than the tidiness of a separate store.
 */
const BASELINE_KEY = "sync:baseline";
const CURSOR_KEY = "sync:cursor";
/** There's one team per install; this is its fixed key in the team store. */
const TEAM_KEY = "team";
/**
 * People, who belong to no team and so can't live inside the team document.
 * Kept in the same store under their own key for the reason above: a new store
 * would need a version bump, and a version bump can hang on a deck.
 */
const ATHLETES_KEY = "athletes";

/** How long to wait for the database to open before giving up on it. */
const OPEN_TIMEOUT_MS = 5000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    /**
     * IndexedDB can simply never answer, and does so silently.
     *
     * An `open` queued behind a `deleteDatabase` that is itself waiting on a
     * connection somewhere will sit there indefinitely — no error, no
     * `onblocked`, nothing. Clearing site data and reloading is the easy way
     * to produce it, and the symptom was the whole app stuck on "Loading…"
     * with no way to find out why.
     *
     * Failing loudly is much better than hanging: the store turns a rejection
     * into a screen that explains itself, and the public pages don't need this
     * database at all.
     */
    const timeout = setTimeout(() => {
      reject(
        new Error(
          "This device's storage didn't respond. Close any other Meet Runner tabs and reload.",
        ),
      );
    }, OPEN_TIMEOUT_MS);
    const settle = <T,>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timeout);
      fn(value);
    };
    // An upgrade can't run while an older connection is still open, and the
    // browser's way of saying so is to do nothing at all. Without this the
    // app waits forever on a loading screen with nothing in the console.
    request.onblocked = settle(() =>
      reject(
        new Error(
          "Another tab has Meet Runner open on an older version. Close it and reload.",
        ),
      ),
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TEAM_STORE)) {
        db.createObjectStore(TEAM_STORE);
      }
      if (!db.objectStoreNames.contains(MEET_STORE)) {
        db.createObjectStore(MEET_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = settle(() => resolve(request.result));
    request.onerror = settle(() => reject(request.error));
  });

  // A rejected promise is cached like any other, so without this a single
  // failure would be permanent for the life of the tab — including the one a
  // reload is meant to clear.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = work(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/* ----------------------------------------------------------------- reading */

export async function readTeam(): Promise<TeamDoc | null> {
  const raw = await run<unknown>(TEAM_STORE, "readonly", (store) =>
    store.get(TEAM_KEY),
  );
  return parseTeamDoc(raw);
}

export async function readAthletes(): Promise<Athlete[]> {
  const raw = await run<unknown>(TEAM_STORE, "readonly", (store) =>
    store.get(ATHLETES_KEY),
  );
  // An *empty* array counts as nothing, not as an empty roster. A sync that
  // ran before this recovery existed will have written one, and treating that
  // as the answer would strand the people still sitting in the team document.
  if (Array.isArray(raw) && raw.length > 0) return raw.map(normalizeAthlete);

  // Nothing under the new key. A device that last ran an older build has its
  // people inside the team document, where they used to live — and
  // `parseTeamDoc` no longer looks at that field, so without this the roster
  // comes back as a list of enrollments pointing at nobody.
  //
  // Read from the raw record rather than the parsed one, precisely because
  // parsing is what drops them. One-shot: it's written forward immediately,
  // so the next launch takes the fast path above.
  const legacy = await run<unknown>(TEAM_STORE, "readonly", (store) =>
    store.get(TEAM_KEY),
  );
  const embedded = (legacy as { athletes?: unknown })?.athletes;
  if (!Array.isArray(embedded) || embedded.length === 0) return [];

  const recovered = embedded.map(normalizeAthlete);
  await writeAthletes(recovered);
  return recovered;
}

/**
 * `fallbackTeamIds` catches meets written before a meet referenced its teams:
 * without it they come back racing nobody and drop off every team's schedule.
 */
export async function readMeets(fallbackTeamIds?: string[]): Promise<MeetDoc[]> {
  const raw = await run<unknown[]>(MEET_STORE, "readonly", (store) =>
    store.getAll(),
  );
  return raw
    .map((item) => parseMeetDoc(item, fallbackTeamIds))
    .filter((meet): meet is MeetDoc => meet !== null)
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
}

/* ----------------------------------------------------------------- writing */

export async function writeTeam(team: TeamDoc): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) => store.put(team, TEAM_KEY));
}

export async function writeAthletes(athletes: Athlete[]): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) => store.put(athletes, ATHLETES_KEY));
}

export async function writeMeet(meet: MeetDoc): Promise<void> {
  await run(MEET_STORE, "readwrite", (store) => store.put(meet));
}

export async function removeMeet(id: string): Promise<void> {
  await run(MEET_STORE, "readwrite", (store) => store.delete(id));
}

/* --------------------------------------------------------------- migration */

/* --------------------------------------------------------------- sync state */

/**
 * The last set of objects the server and this device agreed on, and the
 * cursor that goes with it.
 *
 * This is what makes a small push possible: comparing the season against it
 * says exactly which objects changed, and it carries each object's real
 * timestamp — the documents only have one timestamp between them, which is
 * too coarse to merge on.
 */
export async function readBaseline(): Promise<SyncObject[]> {
  const stored = await run<SyncObject[] | undefined>(
    TEAM_STORE,
    "readonly",
    (store) => store.get(BASELINE_KEY),
  );
  if (!Array.isArray(stored)) return [];

  // A baseline written by an older build has a different shape — objects were
  // scoped by a `teamId` field before scopes existed. It's a cache, not data,
  // so the safe move is to throw the whole thing away rather than to reason
  // about half-converted objects: an empty baseline just means the next sync
  // re-sends the season, which the server merges by object as usual.
  //
  // Dropping the lot rather than the bad rows matters. A partial baseline
  // looks like "everything missing was deleted here", and the next push would
  // faithfully tell the server so.
  const usable = stored.every(
    (object) =>
      object &&
      typeof object === "object" &&
      typeof object.type === "string" &&
      typeof object.scope?.kind === "string",
  );
  return usable ? stored : [];
}

export async function writeBaseline(objects: SyncObject[]): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) =>
    store.put(objects, BASELINE_KEY),
  );
}

export async function readCursor(): Promise<string> {
  const stored = await run<string | undefined>(TEAM_STORE, "readonly", (store) =>
    store.get(CURSOR_KEY),
  );
  return stored ?? "";
}

export async function writeCursor(cursor: string): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) => store.put(cursor, CURSOR_KEY));
}

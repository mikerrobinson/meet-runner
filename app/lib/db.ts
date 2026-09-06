/**
 * On-device storage.
 *
 * A season of meets outgrows localStorage — roughly 150KB per meet against a
 * ~5MB ceiling, and Safari's failure mode is a thrown quota error mid-write,
 * which on a pool deck means losing times. IndexedDB has no practical ceiling
 * here, at the cost of an async API.
 */

import { parseMeetDoc, parseTeamDoc } from "./documents";
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


let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // An upgrade can't run while an older connection is still open, and the
    // browser's way of saying so is to do nothing at all. Without this the
    // app waits forever on a loading screen with nothing in the console.
    request.onblocked = () =>
      reject(
        new Error(
          "Another tab has Meet Runner open on an older version. Close it and reload.",
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

export async function readMeets(): Promise<MeetDoc[]> {
  const raw = await run<unknown[]>(MEET_STORE, "readonly", (store) =>
    store.getAll(),
  );
  return raw
    .map((item) => parseMeetDoc(item))
    .filter((meet): meet is MeetDoc => meet !== null)
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
}

/* ----------------------------------------------------------------- writing */

export async function writeTeam(team: TeamDoc): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) => store.put(team, TEAM_KEY));
}

export async function writeMeet(meet: MeetDoc): Promise<void> {
  await run(MEET_STORE, "readwrite", (store) => store.put(meet));
}

export async function removeMeet(id: string): Promise<void> {
  await run(MEET_STORE, "readwrite", (store) => store.delete(id));
}

export async function wipe(): Promise<void> {
  await run(TEAM_STORE, "readwrite", (store) => store.clear());
  await run(MEET_STORE, "readwrite", (store) => store.clear());
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
  return stored ?? [];
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

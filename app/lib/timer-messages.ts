/**
 * What a timer's phone says, and how it says it.
 *
 * Five messages, one per thing a person behind a lane actually does. Each
 * travels as a cookie whose *name* is the action and whose *path* is the lane
 * it happened on:
 *
 *   submit=1789413369235,30000
 *   Path=/…/api/meets/{meetId}/timer/{event}/{heat}/{lane}
 *
 * A submit carries one field per watch on the lane, so the same message says
 * both "my stopwatch read 30.00" and "the three timers here read 30.00, 30.11
 * and nothing" — `submit=1789413369235,30000,30110,`. Which of those a device
 * is sending is the device's business; the lane, and the server, only see how
 * many columns the sheet has.
 *
 * Which makes the addressing free. A cookie is identified by name, domain and
 * path, so pressing submit twice on the same lane overwrites rather than
 * queues — the browser does the de-duplication that a queue would otherwise
 * have to, and it does it with exactly the key the server writes by. Nothing
 * in the value repeats what the path already says.
 *
 * It also makes delivery free. The browser attaches whatever is pending for a
 * lane to the next request to that lane's URL, with no queue walking a list
 * of payloads. What the client keeps instead is an index of *which lanes*
 * have something outstanding, which is a handful of bytes and is the only
 * part it ever needs to read back.
 *
 * The format is comma-delimited and positional rather than JSON because every
 * byte is inside a cookie: the same four messages as JSON are roughly four
 * times the size, and the ceiling is a hard one the browser enforces by
 * silently dropping the write.
 */

export const TIMER_ACTIONS = [
  "seat",
  "start",
  "stop",
  "submit",
  "exhibition",
] as const;
export type TimerAction = (typeof TIMER_ACTIONS)[number];

/** Where a message happened. Small integers, and all of them in the path. */
export interface LaneRef {
  /** The event's place in the running order, 1-based, as the screen shows it. */
  event: number;
  /** The heat's place within that event, 1-based. */
  heat: number;
  lane: number;
}

export function laneKey(at: LaneRef): string {
  return `${at.event}/${at.heat}/${at.lane}`;
}

export function parseLaneKey(key: string): LaneRef | null {
  const [event, heat, lane] = key.split("/").map(Number);
  if (![event, heat, lane].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { event, heat, lane };
}

/* ---------------------------------------------------------------- payloads */

/**
 * Every message carries the moment the person did the thing, as this device
 * saw it. Not to be trusted as a wall clock — a phone's idea of now can be
 * minutes out — but to order one device's own actions against each other, and
 * to tell a message that has been sitting in a pocket since heat 3 from one
 * that was written a second ago.
 */
export interface SeatMessage {
  at: number;
  /** Which of the meet's racing teams, by position in the meet's own list. */
  team: number;
  /** An athlete already on a list. Empty when the timer typed a name instead. */
  athleteId: string;
  /** A name typed behind the blocks. Empty when one was picked. */
  name: string;
}

export interface StartMessage {
  at: number;
  startedAt: number;
  /**
   * How many watches this device is arming on the lane.
   *
   * One is a phone that is itself the stopwatch. More is a clipboard saying
   * the lane has that many handheld watches behind it — so the desk sees
   * three clocks running on lane 3 rather than one, which is the truth and is
   * the thing a desk watching for an uncovered lane is reading.
   *
   * Absent from anything an older build queued, and read as one.
   */
  watches: number;
}

export interface StopMessage {
  at: number;
  stoppedAt: number;
}

/**
 * Whether this swim counts. Known, and changeable, before there's anything
 * else to say about the lane — a timer decides it from the water, same as
 * who's in it.
 */
export interface ExhibitionMessage {
  at: number;
  exhibition: boolean;
}

export interface SubmitMessage {
  at: number;
  /**
   * The times on the lane, one slot per watch, in the order the sheet lists
   * them. A slot is `null` when that watch has nothing on it — a timer who
   * missed the start, or a clipboard with two of three columns filled.
   *
   * Positional, because position is identity here: the second number is watch
   * 2's time whether or not watch 1 has one, and a sheet that shifted its
   * columns up when a timer missed a start would file one person's reading
   * under another's.
   *
   * Each is a difference between two readings of one clock, which is the only
   * thing about a clock worth trusting, and the same number whether it came
   * off the built-in stopwatch or was read aloud off a handheld one.
   */
  times: Array<number | null>;
}

/* -------------------------------------------------------------- formatting */

/** Commas separate fields, so anything that might contain one is encoded. */
const esc = (value: string) => encodeURIComponent(value);
const unesc = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};

export function formatSeat(m: SeatMessage): string {
  return [m.at, m.team, esc(m.athleteId), esc(m.name)].join(",");
}
export function formatStart(m: StartMessage): string {
  return `${m.at},${m.startedAt},${m.watches}`;
}
export function formatStop(m: StopMessage): string {
  return `${m.at},${m.stoppedAt}`;
}
export function formatSubmit(m: SubmitMessage): string {
  // An empty field is a watch with nothing on it. Trailing ones are kept —
  // they are what says how many watches the lane has.
  return [m.at, ...m.times.map((ms) => ms ?? "")].join(",");
}
export function formatExhibition(m: ExhibitionMessage): string {
  return `${m.at},${m.exhibition ? 1 : 0}`;
}

/* ---------------------------------------------------------------- parsing */

const num = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parsing is deliberately forgiving about extra fields and unforgiving about
 * missing ones. A message from a phone still running last week's build should
 * read as far as it makes sense and then stop, rather than taking down the
 * request that carried it — the alternative is one stale device wedging a
 * lane for the afternoon.
 */
export function parseSeat(raw: string): SeatMessage | null {
  const [at, team, athleteId, name] = raw.split(",");
  if (at === undefined) return null;
  const message = {
    at: num(at),
    team: num(team),
    athleteId: unesc(athleteId ?? ""),
    name: unesc(name ?? "").trim().slice(0, 80),
  };
  // A seat that names nobody is not a seat.
  return message.athleteId || message.name ? message : null;
}

export function parseStart(raw: string): StartMessage | null {
  const [at, startedAt, watches] = raw.split(",");
  if (!startedAt) return null;
  return {
    at: num(at),
    startedAt: num(startedAt),
    // One watch unless the message says otherwise, which is what a phone
    // running the build before clipboards existed means by saying nothing.
    watches: Math.max(1, Math.round(num(watches)) || 1),
  };
}

export function parseStop(raw: string): StopMessage | null {
  const [at, stoppedAt] = raw.split(",");
  if (!stoppedAt) return null;
  return { at: num(at), stoppedAt: num(stoppedAt) };
}

export function parseSubmit(raw: string): SubmitMessage | null {
  const [at, ...fields] = raw.split(",");
  if (fields.length === 0) return null;

  // Zero isn't a time anybody swam, and negative is a clock that went
  // backwards. Either empties that one slot rather than refusing the sheet:
  // the other two watches on the lane are still evidence, and a message the
  // server rejects outright is one the phone throws away.
  const times = fields.map((field) => {
    const ms = num(field);
    return field.trim() !== "" && ms > 0 ? Math.round(ms) : null;
  });

  // A sheet with nothing on it says nothing.
  return times.some((ms) => ms !== null) ? { at: num(at), times } : null;
}

export function parseExhibition(raw: string): ExhibitionMessage | null {
  const [at, exhibition] = raw.split(",");
  if (exhibition === undefined) return null;
  return { at: num(at), exhibition: exhibition === "1" };
}

/**
 * Split a typed name into first and last.
 *
 * Two orders, because a timer types whichever one they are looking at. "Mike
 * Robinson" is what someone writes unprompted; "Robinson, Mike" is what they
 * copy off a heat sheet or off this app's own roster column, which sorts by
 * surname. The comma is the only reliable signal of which is which, and
 * without it a name lands in the meet as "Robinson," — with the punctuation
 * still attached, in the wrong field, in front of a coach at the desk.
 */
export function splitTypedName(raw: string): {
  firstName: string;
  lastName: string;
} {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { firstName: "", lastName: "" };

  const comma = name.indexOf(",");
  if (comma > 0) {
    return {
      lastName: name.slice(0, comma).trim(),
      firstName: name.slice(comma + 1).trim(),
    };
  }

  const cut = name.lastIndexOf(" ");
  return cut > 0
    ? { firstName: name.slice(0, cut), lastName: name.slice(cut + 1) }
    : { firstName: name, lastName: "" };
}

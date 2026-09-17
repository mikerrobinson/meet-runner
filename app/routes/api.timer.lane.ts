import type { Route } from "./+types/api.timer.lane";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import {
  appBaseOf,
  deviceCookie,
  existingDeviceId,
  grantFor,
  grantToken,
} from "~/lib/grants.server";
import {
  deleteWatch,
  ensureLane,
  meetDetail,
  putWatch,
  seedAt,
  setExhibition,
  setSeed,
} from "~/lib/meets.server";
import { slotTimerId } from "~/lib/timing";
import { TIMERS_PER_LANE } from "~/types/meet";
import { putAthlete } from "~/lib/athletes.server";
import { enrolVisitor } from "~/lib/teams.server";
import { generateId } from "~/lib/id";
import {
  TIMER_ACTIONS,
  parseExhibition,
  parseSeat,
  parseStart,
  parseStop,
  parseSubmit,
  splitTypedName,
  type TimerAction,
} from "~/lib/timer-messages";

/**
 * One lane, one timer, everything they have to say about it.
 *
 *   POST /api/meets/{meetId}/timer/{event}/{heat}/{lane}
 *
 * There is no request body. What the phone has to say arrives as cookies the
 * browser attached because their path matches this URL — `seat`, `start`,
 * `stop`, `submit`, `exhibition`, any subset of them — and this clears the
 * ones it consumed on the way out. A phone that has been out of signal since
 * heat 3 sends
 * nothing special: it posts to the lane's URL and the browser brings whatever
 * was still pending along with it.
 *
 * A lane may be more than one watch. `submit` carries a column per stopwatch
 * standing behind the lane, so one phone acting as the clipboard for three
 * timers writes three rows keyed to itself — see `slotTimerId`. A phone that
 * is itself the stopwatch sends one column and writes the one row it always
 * did.
 *
 * Every write here is keyed by heat, lane and timer, which is also what makes
 * the whole thing safe to repeat. If this succeeds and the *response* is lost,
 * the cookies survive, the phone tries again, and the second attempt writes
 * exactly what the first one did. Retrying is free, so the client never has to
 * work out whether it already sent something.
 *
 * The addressing is the meet's own numbering — event 7, heat 1, lane 3, as the
 * screen says it — rather than row ids. That keeps a cookie path short, and it
 * is the only vocabulary a person behind a lane ever sees.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    // Taken once, so every timestamp in this request is translated against the
    // same moment.
    const receivedAt = Date.now();

    const token = grantToken(request);
    if (!token) {
      throw new SyncError("Scan the code your coach gave you to start timing.", 401);
    }
    const grant = await grantFor(db, token);
    if (!grant) {
      throw new SyncError("This timing link has expired. Scan the code again.", 403);
    }
    // The grant says which meet, and the URL has to agree with it. A code for
    // Tuesday's meet cannot write into Thursday's by being pointed at it.
    if (grant.meetId !== params.meetId) {
      throw new SyncError("That code isn't for this meet.", 403);
    }

    /**
     * Which phone this is, from the cookie rather than from the URL.
     *
     * It was a segment of the path until it wasn't needed there: watches are
     * keyed by it, so being wrong about it means a second watch on a lane this
     * device already timed — and a URL segment is only ever what the sender
     * typed, while the cookie was set by the server that minted the id.
     *
     * Minting one here should never happen: this request already carries a
     * grant cookie, and the device cookie was set beside it at the same path
     * in the same response. If it somehow has, the answer is *not* to refuse —
     * a 4xx makes the phone drop the time — but to take one and set it, so
     * that at most this one request is filed under an id of its own.
     */
    const known = existingDeviceId(request);
    const timerId = known ?? `d-${Math.random().toString(36).slice(2, 10)}`;

    const messages = readMessages(request);
    if (messages.size === 0) return json({ applied: 0 });

    /**
     * Resolve the meet's own numbering into the rows it names.
     *
     * Read once, after establishing there is something to do — a phone with an
     * empty pocket shouldn't cost a meet read, and on a deck this endpoint is
     * hit by six phones a heat.
     */
    const detail = await meetDetail(db, grant.meetId);
    if (!detail) throw new SyncError("That meet is no longer on the server", 404);

    const eventNo = Number(params.event);
    const heatNo = Number(params.heat);
    const lane = Number(params.lane);

    const event = detail.events.find((e) => e.position === eventNo - 1);
    if (!event) throw new SyncError(`There is no event ${eventNo}`, 404);

    if (!Number.isInteger(heatNo) || heatNo < 1) {
      throw new SyncError(`There is no heat ${heatNo}`, 400);
    }
    if (!Number.isInteger(lane) || lane < 1 || lane > detail.meet.laneCount) {
      throw new SyncError(`There is no lane ${lane}`, 400);
    }

    // The swim this lane is, if anybody has said who is in it. A `seat`
    // message below may be about to create one.
    let seed = await seedAt(db, event.id, heatNo, lane);

    let applied = 0;

    /* ---- who is in the lane. First, because a time against nobody is a hole. */
    const seat = messages.get("seat");
    if (seat) {
      const parsed = parseSeat(seat);
      if (parsed) {
        let athleteId = parsed.athleteId;

        // A name typed behind the blocks. The person is minted here rather
        // than on the phone: the phone has no way to tell whether it is
        // inventing somebody who already exists, and the id only has to be
        // stable from this moment on.
        if (!athleteId && parsed.name) {
          const { firstName, lastName } = splitTypedName(parsed.name);
          athleteId = generateId();
          await putAthlete(db, {
            id: athleteId,
            firstName,
            lastName,
            gender: "F",
            // No birth date, ever, from this route. A timer is never asked
            // for one, and a blank field on a deck gets guessed at.
          });

          // The team the timer tapped, by its place in this meet's own list —
          // a timer may say "that's a Horizon swimmer", not which team
          // document to write into.
          const team = detail.teams[parsed.team];
          if (team) await enrolVisitor(db, grant.meetId, team.id, athleteId);
        }

        if (athleteId) {
          seed = await setSeed(db, grant.meetId, {
            eventId: event.id,
            heat: heatNo,
            lane,
            athleteId,
          });
          applied += 1;
        }
      }
    }

    /* ---- whether this swim counts. A fact about the lane, like who's in it. */
    const exhibitionMsg = messages.get("exhibition");
    if (exhibitionMsg) {
      const parsed = parseExhibition(exhibitionMsg);
      if (parsed) {
        // Made to exist first, the same as a time arriving for a lane nobody
        // has named — flagging a swim before anybody's said who's in it is
        // not a mistake to refuse.
        if (!seed) {
          seed = await ensureLane(db, grant.meetId, {
            eventId: event.id,
            heat: heatNo,
            lane,
          });
        }
        await setExhibition(db, seed.id, parsed.exhibition);
        applied += 1;
      }
    }

    /* ---- the stopwatch, while it is running. Telemetry, not evidence. */
    const start = messages.get("start") ? parseStart(messages.get("start")!) : null;
    const stop = messages.get("stop") ? parseStop(messages.get("stop")!) : null;
    const submit = messages.get("submit") ? parseSubmit(messages.get("submit")!) : null;

    if (start || stop || submit) {
      /**
       * A time for a lane nobody has named makes the lane.
       *
       * This used to refuse with a 409, and the phone — which drops 4xx so one
       * message the server will never accept can't block every lane behind it
       * — threw the time away without saying so. The race had been swum, timed
       * and submitted, and the evidence was destroyed because nobody tapped a
       * name: which is exactly the step a volunteer watching the water is
       * likeliest to skip, and the one thing that can still be put right
       * afterwards when the swim itself cannot be re-run.
       *
       * So the swim is created with nobody in it and the watch hangs off that.
       * `setSeed` keeps this row's id when a name finally arrives — from the
       * blocks a heat later, or from the desk assigning the lane — so the time
       * is already attached to the swim it belongs to and there is nothing to
       * reconcile by hand.
       */
      if (!seed) {
        seed = await ensureLane(db, grant.meetId, {
          eventId: event.id,
          heat: heatNo,
          lane,
        });
      }

      /**
       * Put the phone's timestamps on the server's clock.
       *
       * A phone's idea of now can be minutes out, and nothing else in this app
       * cares — a time is a difference between two readings of one clock, and
       * that difference is right however wrong the clock is. This is the one
       * place that needs the absolute value: the desk shows a running
       * stopwatch, which means comparing the phone's start against the desk's
       * now, and those are two different clocks.
       *
       * The offset comes from the message itself. It says when the thumb
       * landed and it arrives at a known moment, and `start` is flushed the
       * instant it is made, so the difference is the phone's error plus a
       * network hop.
       */
      const onServerClock = (message: { at: number }, value: number) =>
        message.at > 0 ? value + (receivedAt - message.at) : value;

      /**
       * How many watches this phone is speaking for.
       *
       * One is the phone that is itself the stopwatch, and is every message
       * this endpoint saw before clipboards existed. More is a clipboard: one
       * device behind a lane with two or three handheld watches read out to
       * it, which is what timing a lane actually looks like on a deck.
       *
       * The submitted sheet is the authority when there is one — its columns
       * *are* the watches — and the arming message says so only until then.
       * Capped rather than believed, so a mangled cookie cannot ask for a
       * hundred rows on one swim.
       */
      const columns = Math.min(
        Math.max(...TIMERS_PER_LANE),
        submit ? submit.times.length : (start?.watches ?? 1),
      );

      /**
       * One row per watch, all of them keyed to this device.
       *
       * A submit is the whole sheet, so a column with nothing in it is a
       * statement — that watch has no time — and the row for it goes. That is
       * what keeps the desk honest: a lane armed for three and submitted with
       * two would otherwise read as forever waiting on a third watch nobody
       * is holding, and it is how a device that swaps between clipboard and
       * its own stopwatch mid-meet leaves exactly one set of watches behind.
       */
      for (let slot = 1; slot <= Math.max(...TIMERS_PER_LANE); slot++) {
        const id = slotTimerId(timerId, slot);
        const timeMs = submit ? (submit.times[slot - 1] ?? undefined) : undefined;

        if (slot > columns || (submit && timeMs === undefined)) {
          // Only a sheet retires a watch. A start says nothing about the
          // columns it didn't mention.
          if (submit) await deleteWatch(db, seed.id, id);
          continue;
        }

        await putWatch(db, grant.meetId, {
          seedId: seed.id,
          timerId: id,
          // A grant is a lane and a stopwatch, nothing else — there is no
          // account behind it and no other role it could be.
          role: "timer",
          timeMs,
          recordedAt: submit?.at || receivedAt,
          startedAt: start ? onServerClock(start, start.startedAt) : undefined,
          stoppedAt: stop ? onServerClock(stop, stop.stoppedAt) : undefined,
        });
      }
      applied += 1;
    }

    // Consumed. Clearing them is what stops the next request to this lane
    // carrying the same afternoon all over again.
    //
    // Built here rather than through `json`, which takes a plain object of
    // headers and so can only hold one `set-cookie`. Clearing four cookies
    // needs four of them.
    const headers = clearHeaders(request, messages.keys());
    if (!known) {
      headers.append(
        "set-cookie",
        deviceCookie(timerId, request, appBaseOf(request, "/api/")),
      );
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ applied }), { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The action cookies on this request, by name. */
function readMessages(request: Request): Map<TimerAction, string> {
  const found = new Map<TimerAction, string>();
  const jar = request.headers.get("cookie");
  if (!jar) return found;

  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const action = TIMER_ACTIONS.find((a) => a === name);
    if (action && rest.length) {
      try {
        found.set(action, decodeURIComponent(rest.join("=")));
      } catch {
        // A value we can't even decode is one we can't act on.
      }
    }
  }
  return found;
}

/**
 * Delete exactly what was read, and nothing else.
 *
 * The path has to match the one the cookie was set at or the browser keeps
 * both — so it is rebuilt from the URL this request arrived on, which is the
 * same string by construction.
 */
function clearHeaders(
  request: Request,
  actions: Iterable<TimerAction>,
): Headers {
  const headers = new Headers();
  const path = new URL(request.url).pathname;
  const https = new URL(request.url).protocol === "https:";
  for (const action of actions) {
    headers.append(
      "set-cookie",
      `${action}=; Path=${path}; SameSite=Lax; Max-Age=0${https ? "; Secure" : ""}`,
    );
  }
  return headers;
}

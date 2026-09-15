import type { Route } from "./+types/api.timer.lane";
import {
  SyncError,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { grantFor, grantToken } from "~/lib/grants.server";
import { meetDetail, putWatch, setSeat } from "~/lib/meets.server";
import { putAthlete } from "~/lib/athletes.server";
import { enrolVisitor } from "~/lib/teams.server";
import { markActivity, readActivity } from "~/lib/timer.server";
import { generateId } from "~/lib/id";
import {
  TIMER_ACTIONS,
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
 *   POST /api/meets/{meetId}/timers/{timerId}/{event}/{heat}/{lane}
 *
 * There is no request body. What the phone has to say arrives as cookies the
 * browser attached because their path matches this URL — `seat`, `start`,
 * `stop`, `submit`, any subset of them — and this clears the ones it consumed
 * on the way out. A phone that has been out of signal since heat 3 sends
 * nothing special: it posts to the lane's URL and the browser brings whatever
 * was still pending along with it.
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

    const timerId = String(params.timerId ?? "").slice(0, 40);
    if (!timerId) throw new SyncError("Which device?", 400);

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

    const heat = detail.heats.find(
      (h) => h.eventId === event.id && h.index === heatNo - 1,
    );
    if (!heat) throw new SyncError(`There is no heat ${heatNo} in that event`, 404);

    if (!Number.isInteger(lane) || lane < 1 || lane > heat.lanes.length) {
      throw new SyncError(`There is no lane ${lane}`, 400);
    }

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
          await setSeat(db, grant.meetId, { heatId: heat.id, lane, athleteId });
          applied += 1;
        }
      }
    }

    /* ---- the stopwatch, while it is running. Telemetry, not evidence. */
    const start = messages.get("start") ? parseStart(messages.get("start")!) : null;
    const stop = messages.get("stop") ? parseStop(messages.get("stop")!) : null;
    if (start || stop) {
      /**
       * Put the phone's timestamps on the server's clock.
       *
       * A phone's idea of now can be minutes out, and nothing else in this app
       * cares — a time is a difference between two readings of one clock, and
       * that difference is right however wrong the clock is. This is the one
       * place that needs the absolute value: the desk wants to show a running
       * stopwatch, which means comparing the phone's start against the desk's
       * now, and those are two different clocks.
       *
       * The offset comes from the message itself. It says when the thumb
       * landed (`at`) and it arrives at a known moment, so the difference is
       * the phone's error plus however long the message took to get here — and
       * `start` is flushed the instant it is made, so that second part is a
       * network hop.
       *
       * A message that sat in a pocket through a dead spot has that whole
       * delay folded into the offset, and comes out looking like it started
       * just now. That is wrong, and it is nearly always invisible: the
       * `submit` for that race flushes in the same breath, and a lane whose
       * time has arrived never draws a running clock.
       */
      const offsetFrom = (message: { at: number }) =>
        message.at > 0 ? receivedAt - message.at : 0;

      await markActivity(db, grant.meetId, {
        heatId: heat.id,
        lane,
        timerId,
        startedAt: start ? start.startedAt + offsetFrom(start) : undefined,
        stoppedAt: stop ? stop.stoppedAt + offsetFrom(stop) : undefined,
      });
      applied += 1;
    }

    /* ---- the time. The only one of the four that is a result. */
    const submitRaw = messages.get("submit");
    if (submitRaw) {
      const parsed = parseSubmit(submitRaw);
      if (parsed) {
        /**
         * Whether the built-in stopwatch ran this race is read from the
         * record, not from this request.
         *
         * The four messages need not arrive together — `start` goes up alone
         * the instant the thumb lands, so that the desk sees an armed lane
         * before the gun, and is long since accepted and cleared by the time
         * `submit` follows. Judging by what this request happens to carry
         * left every properly-timed lane looking typed in.
         *
         * The two timestamps *are* the answer, so there is nothing else to
         * set: a watch carrying both came off a stopwatch, and one carrying
         * neither was typed.
         */
        const activity = await readActivity(db, heat.id, lane, timerId);

        await putWatch(db, grant.meetId, {
          heatId: heat.id,
          lane,
          timerId,
          // A grant is a lane and a stopwatch, nothing else — there is no
          // account behind it and no other role it could be.
          role: "timer",
          timeMs: parsed.elapsedMs,
          recordedAt: parsed.at || Date.now(),
          startedAt: activity.startedAt,
          stoppedAt: activity.stoppedAt,
        });
        applied += 1;
      }
    }

    // Consumed. Clearing them is what stops the next request to this lane
    // carrying the same afternoon all over again.
    //
    // Built here rather than through `json`, which takes a plain object of
    // headers and so can only hold one `set-cookie`. Clearing four cookies
    // needs four of them.
    const headers = clearHeaders(request, messages.keys());
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

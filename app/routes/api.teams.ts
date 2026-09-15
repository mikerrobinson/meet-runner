import type { Route } from "./+types/api.teams";
import {
  currentUser,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { teamsCoachedBy } from "~/lib/coaches.server";
import { listPublicTeams } from "~/lib/public.server";
import { createSeason, createTeam } from "~/lib/teams.server";
import { startTeam } from "~/lib/auth.server";
import { requireUser, readJson, SyncError } from "~/lib/api.server";

/**
 * The teams this server knows about.
 *
 *   GET /api/teams          -> all of them, public
 *   GET /api/teams?mine=1   -> only the ones the caller is actually on
 *
 * The plain list is open, because a team's name and size are on every heat
 * sheet and someone setting up a meet has to be able to find their opponent.
 * `mine=1` is the ones this person coaches — what a device uses to decide
 * which season it holds — and answers with nothing at all when nobody is
 * signed in.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const teams = await listPublicTeams(db);

    if (new URL(request.url).searchParams.get("mine") !== "1") {
      return json({ teams });
    }

    const user = await currentUser(request, env);
    if (!user) return json({ teams: [] });

    const mine = new Set(await teamsCoachedBy(db, user.id));
    return json({ teams: teams.filter((team) => mine.has(team.id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Make a team.
 *
 *   POST /api/teams { name, code? }              -> a team nobody coaches
 *   POST /api/teams { name, code?, coach: true } -> a team you coach
 *
 * The first is how an opponent gets into a meet. Setting one up against a
 * school that has never used the app shouldn't require someone from that
 * school to sign up first, so the team is minted with no coach and a coach
 * from there can claim it later — the meets it already appears in are
 * unaffected, because they reference it by id.
 *
 * The second is starting your own, and the flag is the whole difference: a
 * team created with nobody coaching it is indistinguishable from an unclaimed
 * one, and the next person along could take it.
 *
 * Signing in is required either way. Not because a team is sensitive — it
 * isn't — but because an unauthenticated create endpoint is an invitation to
 * fill the table with junk.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const user = await requireUser(request, env);

    const body = await readJson<{
      name?: string;
      code?: string;
      coach?: boolean;
    }>(request);
    const name = String(body.name ?? "").trim().slice(0, 60);
    if (!name) throw new SyncError("A team needs a name", 400);

    const existing = await listPublicTeams(db);
    const clash = existing.find(
      (team) => team.name.toLowerCase() === name.toLowerCase(),
    );
    // Naming a team that already exists means the one that exists, not a
    // second copy of it — two "Horizon"s is the failure this whole change was
    // meant to prevent.
    if (clash) return json({ team: clash, created: false });

    // `startTeam` writes the team, its first season and the coach together; the
    // unclaimed path writes the first two, because a team with no season can
    // hold no roster and every path that adds one asks which season it's for.
    const team = body.coach
      ? await startTeam(db, user.id, { name, code: body.code })
      : await createTeam(db, { name, code: body.code, createdBy: user.id });
    if (!body.coach) {
      await createSeason(db, { teamId: team.id, name: "Current season" });
    }

    return json({
      team: {
        id: team.id,
        name: team.name,
        code: team.code,
        claimed: body.coach === true,
        athletes: 0,
        meets: 0,
        times: 0,
      },
      created: true,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

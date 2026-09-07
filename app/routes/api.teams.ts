import type { Route } from "./+types/api.teams";
import {
  currentUser,
  errorResponse,
  json,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { membershipsFor } from "~/lib/auth.server";
import { listPublicTeams } from "~/lib/public.server";
import { pushObjects } from "~/lib/sync.server";
import { createTeam } from "~/lib/documents";
import { normalizeTeamCode } from "~/types/meet";
import { requireUser, readJson, SyncError } from "~/lib/api.server";
import type { SyncObject } from "~/lib/objects";

/**
 * The teams this server knows about.
 *
 *   GET /api/teams          -> all of them, public
 *   GET /api/teams?mine=1   -> only the ones the caller is actually on
 *
 * The plain list is open, because a team's name and size are on every heat
 * sheet and someone setting up a meet has to be able to find their opponent.
 * `mine=1` is what a device uses to decide which season it holds, and answers
 * with nothing at all when nobody is signed in.
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

    const mine = new Set(
      (await membershipsFor(db, user.id))
        .filter((m) => m.status === "active")
        .map((m) => m.teamId),
    );
    return json({ teams: teams.filter((team) => mine.has(team.id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Create a team nobody owns yet.
 *
 *   POST /api/teams { name, code? } -> the new team
 *
 * This is how an opponent gets into a meet. Setting one up against a school
 * that has never used the app shouldn't require someone from that school to
 * sign up first, so the team is minted unclaimed and a coach from there can
 * claim it later — the meets it already appears in are unaffected, because
 * they reference it by id.
 *
 * Not part of `/api/sync` on purpose. That endpoint refuses writes outside the
 * caller's own team, which is exactly the boundary that makes a shared meet
 * safe; creating a *different* team is a deliberate act with its own door.
 *
 * Signing in is required. Not because a team is sensitive — it isn't — but
 * because an unauthenticated create endpoint is an invitation to fill the
 * table with junk.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    await requireUser(request, env);

    const body = await readJson<{ name?: string; code?: string }>(request);
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

    const team = createTeam(name);
    team.code = normalizeTeamCode(body.code ?? "");
    const season = team.seasons[0];

    const objects: SyncObject[] = [
      {
        id: team.id,
        type: "team",
        scope: { kind: "team", id: team.id },
        updatedAt: team.updatedAt,
        data: {
          name: team.name,
          code: team.code,
          currentSeasonId: team.currentSeasonId,
        },
      },
      {
        id: season.id,
        type: "season",
        scope: { kind: "team", id: team.id },
        updatedAt: team.updatedAt,
        data: season,
      },
    ];
    await pushObjects(db, objects);

    return json({
      team: {
        id: team.id,
        name: team.name,
        code: team.code,
        claimed: false,
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

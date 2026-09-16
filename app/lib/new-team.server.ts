/**
 * Making a team, and the one rule that governs it.
 *
 * **A name that is already here means the team that has it.** Two rows for one
 * school is the failure this whole model was built to prevent — two coaches
 * pointing at different rosters for the same children — so naming an existing
 * team hands back the existing team rather than minting a rival.
 *
 * That rule used to be written three times: once in the create endpoint, once
 * in the teams page's own action, and once implicitly by the picker that
 * called the endpoint. They had already drifted — the endpoint adopted the
 * clash silently, the page refused with a message — which is exactly the kind
 * of difference nobody notices until two schools are involved.
 *
 * It lives in a module of its own because the four screens that can start a
 * team sit above different halves of the server: the list of teams, the new
 * meet sheet, a meet's own page, and the picker somebody lands on with no team
 * at all.
 */

import { listPublicTeams } from "./public.server";
import { startTeam } from "./auth.server";
import { createSeason, createTeam } from "./teams.server";
import type { PublicTeam } from "./public";

export interface TeamOutcome {
  team: PublicTeam;
  /** False when the name was already taken, and `team` is the one that has it. */
  created: boolean;
}

export async function findOrCreateTeam(
  db: D1Database,
  input: {
    name: string;
    code?: string;
    /** Who is asking. Recorded against an unclaimed team as who typed it in. */
    by: string;
    /**
     * Whose team it is, or absent for an unclaimed one.
     *
     * The whole difference between starting your own and typing in an
     * opponent. Setting up a meet against a school that has never used the app
     * must not wait on somebody from that school signing up, so their team is
     * minted with no coach and a coach from there claims it later — the meets
     * it already appears in are unaffected, because they reference it by id.
     *
     * A team created with nobody coaching it is indistinguishable from an
     * unclaimed one, which is why starting your own has to say so here rather
     * than adding the coach afterwards.
     */
    coachId?: string | null;
  },
): Promise<TeamOutcome> {
  const name = input.name.trim().slice(0, 80);
  const existing = await listPublicTeams(db);
  const clash = existing.find(
    (team) => team.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) return { team: clash, created: false };

  // `startTeam` writes the team, its first season and the coach together. The
  // unclaimed path writes the first two, because a team with no season can
  // hold no roster and every path that adds one asks which season it is for.
  const team = input.coachId
    ? await startTeam(db, input.coachId, { name, code: input.code })
    : await createTeam(db, { name, code: input.code, createdBy: input.by });
  if (!input.coachId) {
    await createSeason(db, { teamId: team.id, name: "Current season" });
  }

  return {
    team: {
      id: team.id,
      name: team.name,
      code: team.code,
      claimed: Boolean(input.coachId),
      athletes: 0,
      meets: 0,
      times: 0,
    },
    created: true,
  };
}

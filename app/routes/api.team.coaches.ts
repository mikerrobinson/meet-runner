import type { Route } from "./+types/api.team.coaches";
import {
  SyncError,
  appBaseUrl,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { createInvite, inviteUser, supersedeInvites } from "~/lib/auth.server";
import {
  addTeamCoach,
  claimTeam,
  isTeamCoach,
  removeTeamCoach,
  teamCoaches,
} from "~/lib/coaches.server";
import { parseContact } from "~/lib/identity";
import { getTeam } from "~/lib/teams.server";
import { revealsCodes, sendTeamInvite } from "~/lib/notify.server";

/**
 * Who coaches a team.
 *
 *   GET    /api/teams/:teamId/coaches                    -> the list
 *   POST   /api/teams/:teamId/coaches { userId }         -> make someone here a coach
 *   POST   /api/teams/:teamId/coaches { contact, name? } -> invite someone who isn't
 *   POST   /api/teams/:teamId/coaches { claim: true }    -> take on a team nobody coaches
 *   DELETE /api/teams/:teamId/coaches { userId }         -> take it back, or step down
 *
 * The same shape as the meet's own administrator list, deliberately: a team has as
 * many coaches as it needs, only a coach can add one, and it cannot go down to
 * none. Both invite forms end the same way — a row in `team_coaches` and a
 * link in the post — and the difference is only whether the account had to be
 * made first, which is the app's problem rather than something the screen
 * should have to ask about before it knows the answer.
 *
 * Claiming is the one thing anybody signed in may do, and only to a team with
 * no coaches at all: that is the bootstrap, since the teams typed in as
 * opponents have nobody inside to let their real coach in.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    const coaches = await teamCoaches(db, params.teamId);
    const youCoachThis = coaches.some((coach) => coach.userId === user?.id);
    return json({
      // Who coaches a team is as public as the team is — it's on the heat
      // sheet. How to reach them isn't, so the contact is only for the people
      // who already have it, which is the one difference from a meet's
      // administrators: a meet is an event you turn up to, a team is a school
      // full of children.
      coaches: youCoachThis
        ? coaches
        : coaches.map((coach) => ({ ...coach, contact: null })),
      youCoachThis,
      /** True when this team is anybody's for the asking — see `claimTeam`. */
      claimable: coaches.length === 0,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);

    const body = await readJson<{
      userId?: string;
      contact?: string;
      name?: string;
      claim?: boolean;
    }>(request);

    // Taking on an unclaimed team is the one move that doesn't require being
    // inside already, so it's answered before the check everything else goes
    // through. `claimTeam` refuses the moment anybody is there.
    if (request.method === "POST" && body.claim) {
      const claimed = await claimTeam(db, params.teamId, user.id);
      if (!claimed.ok) throw new SyncError(claimed.reason, 409);
      return json({ coaches: await teamCoaches(db, params.teamId) });
    }

    if (!(await isTeamCoach(db, user.id, params.teamId))) {
      throw new SyncError("Only a coach of this team can change that", 403);
    }

    if (request.method === "DELETE") {
      if (!body.userId) throw new SyncError("Which person?", 400);
      const result = await removeTeamCoach(db, params.teamId, body.userId);
      if (!result.ok) throw new SyncError(result.reason, 400);
      return json({ coaches: await teamCoaches(db, params.teamId) });
    }

    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    // Somebody with an account, picked from the directory.
    if (body.userId) {
      await addTeamCoach(db, params.teamId, body.userId, user.id);
      return json({ coaches: await teamCoaches(db, params.teamId) });
    }

    // Somebody who may not have one yet. `inviteUser` returns the existing
    // account when the contact already has one, so typing an address that
    // turns out to be a member appoints them rather than making a second
    // account for the same person.
    if (!body.contact) throw new SyncError("Which person?", 400);
    const parsed = parseContact(body.contact);
    if (!parsed.ok) throw new SyncError(parsed.error, 400);

    const { user: invitee } = await inviteUser(db, parsed.contact, body.name ?? null);
    await addTeamCoach(db, params.teamId, invitee.id, user.id);

    // Resending replaces the outstanding link rather than adding a second.
    await supersedeInvites(db, {
      teamId: params.teamId,
      contact: parsed.contact.value,
    });
    const token = await createInvite(
      db,
      { teamId: params.teamId, contact: parsed.contact.value },
      user.id,
    );
    const link = `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`;
    const team = await getTeam(db, params.teamId);
    const delivery = await sendTeamInvite(
      env,
      parsed.contact,
      team?.name ?? "a team",
      link,
    );

    return json({
      coaches: await teamCoaches(db, params.teamId),
      sent: delivery.sent,
      detail: delivery.detail,
      // Local builds only, exactly as with login codes: without a provider
      // configured there is otherwise no way to follow your own invite.
      ...(revealsCodes(env) ? { link } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

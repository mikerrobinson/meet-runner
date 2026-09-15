import type { Route } from "./+types/api.meet.admins";
import {
  SyncError,
  appBaseUrl,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import { currentUser } from "~/lib/api.server";
import {
  addMeetAdmin,
  isMeetAdmin,
  meetAdmins,
  removeMeetAdmin,
} from "~/lib/admins.server";
import { createInvite, inviteUser, supersedeInvites } from "~/lib/auth.server";
import { parseContact } from "~/lib/identity";
import { revealsCodes, sendMeetInvite } from "~/lib/notify.server";

/**
 * Who runs a meet.
 *
 *   GET    /api/meets/:meetId/admins                    -> the list
 *   POST   /api/meets/:meetId/admins { userId }         -> appoint someone here
 *   POST   /api/meets/:meetId/admins { contact, name? } -> invite someone who isn't
 *   DELETE /api/meets/:meetId/admins { userId }         -> take it back, or step down
 *
 * Only an administrator may add or remove one, which makes this the same shape
 * as every other "who's in charge" question in the app: you can't appoint
 * yourself, somebody already trusted has to do it.
 *
 * Both POST forms end the same way — a row in `meet_admins` and a link in the
 * post. The difference is only whether the account had to be made first, which
 * is the app's problem rather than something the screen should have to ask
 * about before it knows the answer.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await currentUser(request, env);
    return json({
      admins: await meetAdmins(db, params.meetId),
      // So a screen can show the controls without a second round trip.
      youRunThis: await isMeetAdmin(db, user?.id, params.meetId),
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

    if (!(await isMeetAdmin(db, user.id, params.meetId))) {
      throw new SyncError("Only someone running this meet can change that", 403);
    }

    const body = await readJson<{
      userId?: string;
      contact?: string;
      name?: string;
    }>(request);

    if (request.method === "DELETE") {
      if (!body.userId) throw new SyncError("Which person?", 400);
      const result = await removeMeetAdmin(db, params.meetId, body.userId);
      if (!result.ok) throw new SyncError(result.reason, 400);
      return json({ admins: await meetAdmins(db, params.meetId) });
    }

    if (request.method !== "POST") throw new SyncError("Use POST or DELETE", 405);

    // Somebody with an account, picked from the directory.
    if (body.userId) {
      await addMeetAdmin(db, params.meetId, body.userId, user.id);
      return json({ admins: await meetAdmins(db, params.meetId) });
    }

    // Somebody who may not have one yet. `inviteUser` returns the existing
    // account when the contact already has one, so typing an address that
    // turns out to be a member appoints them rather than making a second
    // account for the same person.
    if (!body.contact) throw new SyncError("Which person?", 400);
    const parsed = parseContact(body.contact);
    if (!parsed.ok) throw new SyncError(parsed.error, 400);

    const { user: invitee } = await inviteUser(db, parsed.contact, body.name ?? null);
    await addMeetAdmin(db, params.meetId, invitee.id, user.id);

    // Resending replaces the outstanding link rather than adding a second.
    await supersedeInvites(db, {
      meetId: params.meetId,
      contact: parsed.contact.value,
    });
    const token = await createInvite(
      db,
      { meetId: params.meetId, contact: parsed.contact.value },
      user.id,
    );
    const link = `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`;
    const delivery = await sendMeetInvite(env, parsed.contact, link);

    return json({
      admins: await meetAdmins(db, params.meetId),
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

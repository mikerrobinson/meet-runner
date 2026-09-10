import type { Route } from "./+types/api.profile";
import {
  SyncError,
  errorResponse,
  json,
  readJson,
  requireDb,
  requireUser,
  type SyncEnv,
} from "~/lib/api.server";
import {
  addIdentity,
  identitiesFor,
  removeIdentity,
  consumeLoginCode,
  setName,
  startChallenge,
} from "~/lib/auth.server";
import { maskContact, parseContact } from "~/lib/identity";
import { revealsCodes, sendLoginCode } from "~/lib/notify.server";

/**
 * Somebody's own account: their name, and the contacts they sign in with.
 *
 *   GET    /api/profile                              -> name and contacts
 *   PATCH  /api/profile { name }                     -> rename
 *   POST   /api/profile { contact }                  -> send a code to a new contact
 *   POST   /api/profile { contact, code }            -> prove it, and attach it
 *   DELETE /api/profile { contact }                  -> detach one
 *
 * Adding a contact goes through the same challenge as signing in, and that
 * isn't ceremony: an address you can't read isn't yours, and without the proof
 * anyone could attach someone else's email to their own account and then use
 * it to sign in as them.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    return json({
      name: user.name,
      identities: await identitiesFor(db, user.id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson<{
      name?: string;
      contact?: string;
      code?: string;
    }>(request);

    if (request.method === "PATCH") {
      await setName(db, user.id, String(body.name ?? "").trim().slice(0, 80));
      return json({ name: body.name, identities: await identitiesFor(db, user.id) });
    }

    if (request.method === "DELETE") {
      if (!body.contact) throw new SyncError("Which contact?", 400);
      const result = await removeIdentity(db, user.id, body.contact);
      if (!result.ok) throw new SyncError(result.reason, 400);
      return json({ identities: await identitiesFor(db, user.id) });
    }

    if (request.method !== "POST") throw new SyncError("Use PATCH, POST or DELETE", 405);

    const parsed = parseContact(String(body.contact ?? ""));
    if (!parsed.ok) throw new SyncError(parsed.error, 400);

    // No code yet: send one. Same path as signing in, so the same rate limit
    // and the same expiry apply.
    if (!body.code) {
      const start = await startChallenge(db, parsed.contact);
      if (!start.ok) {
        throw new SyncError(
          `A code has just been sent. Try again in ${Math.ceil(start.retryInMs / 1000)}s.`,
          429,
        );
      }
      // No sign-in link: this code attaches a contact to an account you're
      // already signed into, so a link that opens the sign-in screen would be
      // the wrong door.
      const delivery = await sendLoginCode(env, parsed.contact, start.code, "");
      return json({
        sent: delivery.sent,
        masked: maskContact(parsed.contact),
        detail: delivery.detail,
        // Only ever in development, where no provider is configured.
        code: revealsCodes(env) ? start.code : undefined,
      });
    }

    // `consumeLoginCode`, not `verifyChallenge`: the code proves you can read
    // the contact, and nothing more. Verifying here would mint an account for
    // the new contact, which would then own it and refuse the attach below.
    const spent = await consumeLoginCode(db, parsed.contact, body.code);
    if (!spent.ok) {
      throw new SyncError("That code didn't work. Ask for a new one.", 400);
    }

    const result = await addIdentity(db, user.id, parsed.contact);
    if (!result.ok) throw new SyncError(result.reason, 409);

    return json({ identities: await identitiesFor(db, user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

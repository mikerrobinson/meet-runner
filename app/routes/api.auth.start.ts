import type { Route } from "./+types/api.auth.start";
import {
  SyncError,
  appBaseUrl,
  errorResponse,
  json,
  readJson,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { startChallenge, tidy } from "~/lib/auth.server";
import { maskContact, parseContact } from "~/lib/identity";
import { revealsCodes, sendLoginCode } from "~/lib/notify.server";

/**
 * Ask for a login code.
 *
 *   POST { contact } -> { kind, masked, sent }
 *
 * The reply says nothing about whether the contact belongs to anyone. There's
 * no sign-up to distinguish it from — a code goes to whatever was typed, and
 * an account appears only if someone reads it — so the endpoint can't be used
 * to find out who has an account here.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const body = await readJson<{ contact?: string }>(request);
    const parsed = parseContact(body.contact ?? "");
    if (!parsed.ok) throw new SyncError(parsed.error, 400);

    const db = requireDb(env);
    await tidy(db);

    const started = await startChallenge(db, parsed.contact);
    if (!started.ok) {
      throw new SyncError(
        `A code has just been sent. Try again in ${Math.ceil(started.retryInMs / 1000)}s.`,
        429,
      );
    }

    const link = `${appBaseUrl(request)}sign-in?contact=${encodeURIComponent(
      parsed.contact.value,
    )}&code=${started.code}`;
    const delivery = await sendLoginCode(env, parsed.contact, started.code, link);

    return json({
      kind: parsed.contact.kind,
      contact: parsed.contact.value,
      masked: maskContact(parsed.contact),
      sent: delivery.sent,
      // Only when the server is explicitly running in local mode. Everywhere
      // else the code exists solely in the message that was sent.
      ...(revealsCodes(env) ? { code: started.code, detail: delivery.detail } : {}),
      ...(delivery.sent ? {} : { detail: delivery.detail }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

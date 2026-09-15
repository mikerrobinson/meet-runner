import { data, redirect } from "react-router";
import type { Route } from "./+types/timer-claim";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import {
  deviceCookie,
  deviceId,
  grantCookie,
  grantFor,
} from "~/lib/grants.server";

/**
 * What a scanned QR code lands on, and never renders.
 *
 * Two jobs, both done on the server during a redirect: trade the token in the
 * URL for a cookie, and work out who this phone is. Then send it to its own
 * address — `/meets/{meetId}/timers/{timerId}` — where it picks a lane.
 *
 * There is no component here and nothing to hydrate. The browser follows a
 * 302 and arrives already carrying the credential, which is what makes timing
 * work on a phone that may refuse to store anything a script asks it to.
 *
 * Getting the token out of the address bar is the other half of the first job.
 * A URL still holding the credential is one that ends up screenshotted into a
 * group chat, pasted into a message, or sitting in a shared phone's history
 * long after the meet.
 *
 * A dead token is still worth a redirect: the timing screens are where the
 * explaining happens, and they say the link expired rather than leaving
 * somebody on a page with nothing on it.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const grant = await grantFor(db, params.token);

  /**
   * The app's own base, read off the URL we were reached at.
   *
   * `/t/` is a known suffix, so removing it leaves the base — `/` in dev and
   * `/projects/meet-runner/` in production, with no config to keep in step.
   *
   * It scopes the cookies, and *only* the cookies. The redirect below is a
   * bare path because the framework prefixes the basename itself on the way
   * out; building an absolute one here as well produced a `Location` of
   * `/projects/meet-runner/projects/meet-runner/…`.
   */
  const { pathname } = new URL(request.url);
  const base = pathname.slice(0, pathname.lastIndexOf("/t/") + 1);

  const headers = new Headers();
  headers.append(
    "set-cookie",
    grantCookie(grant ? params.token! : null, request, {
      path: base,
      expiresAt: grant?.expiresAt,
    }),
  );

  /**
   * A dead token has nowhere to be sent.
   *
   * Every timing screen lives under `/meets/{meetId}/…`, and without a grant
   * there is no meet id to build one from. So this is the one case this route
   * renders rather than redirects — and it must be a render, because any URL
   * it could redirect to that still looks like a token would land back here
   * and do it again.
   */
  if (!grant) return data({ expired: true }, { headers });

  const device = deviceId(request);
  headers.append("set-cookie", deviceCookie(device, request, base));

  return redirect(`/meets/${grant.meetId}/timers/${device}`, { headers });
}

export default function TimerClaim() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-bold text-slate-900 dark:text-white">
        Not timing yet
      </h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        This timing link has expired, or it has been replaced by a newer one.
        Scan the code on the timing table again.
      </p>
    </main>
  );
}

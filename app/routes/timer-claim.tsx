import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import type { Route } from "./+types/timer-claim";
import { adoptGrant } from "~/lib/timer";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Meet Runner" }];
}

/**
 * What a scanned QR code lands on.
 *
 * It does one thing: keep the token and get the token out of the address bar.
 * A URL that still holds the credential is a URL that ends up screenshotted
 * into a group chat, pasted into a message, or sitting in a browser's history
 * on a shared phone long after the meet — so it's replaced immediately.
 *
 * There's nothing to read here, so there's nothing to look at either.
 */
export default function TimerClaim() {
  const { token } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (token) adoptGrant(token);
    navigate("/timer", { replace: true });
  }, [token, navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center text-slate-400">
      Getting ready…
    </main>
  );
}

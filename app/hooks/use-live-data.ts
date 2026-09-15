import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { useOutbox } from "~/state/outbox";

/**
 * How often a meet screen asks what changed.
 *
 * Matched to the timer's own poll, and about the ceiling of what polling can
 * sensibly do: the thing being watched for — a time landing from a phone
 * behind lane 4 — matters in the seconds after a race and not at all an hour
 * later. A meet read is a handful of indexed single-table selects, which is
 * what makes three seconds affordable in the first place.
 */
export const LIVE_POLL_MS = 3000;

/**
 * Keep this screen's loader data fresh while somebody is looking at it.
 *
 * Loaders only re-run when *this* device navigates or finishes a write, which
 * is fine everywhere except under a running meet: three phones are writing
 * times to lanes this screen is showing, and without this the control desk
 * sees none of them until somebody touches something. On a deck that's the
 * difference between watching times land and refreshing.
 *
 * Three things stop it being wasteful, and each one is a reason on its own:
 *
 * - **Only while visible.** A pocketed phone has nobody reading it, and the
 *   browser throttles its timers to uselessness anyway. Coming back to the tab
 *   polls immediately rather than waiting out the interval.
 * - **Never on top of itself.** A slow read on bad wifi would otherwise stack
 *   requests behind each other until the signal came back and all of them
 *   landed at once.
 * - **Not while this device owes writes.** The outbox already revalidates the
 *   moment it drains, so a poll landing mid-queue would replace the screen
 *   with server rows that `applyPending` immediately patches back — churn
 *   under somebody's thumb for no new information.
 *
 * Revalidation is its own piece of router state, separate from navigation, so
 * none of this reaches the header's status chip. It is meant to be invisible:
 * times appear, and nothing announces that they did.
 */
export function useLiveData(intervalMs: number = LIVE_POLL_MS): void {
  const revalidator = useRevalidator();
  const outbox = useOutbox();

  // Read through a ref so the interval is created once and never restarted by
  // a change of queue length — which, on a busy deck, is most seconds.
  const latest = useRef({ revalidate: revalidator.revalidate, ready: true });
  latest.current = {
    revalidate: revalidator.revalidate,
    ready: revalidator.state === "idle" && outbox.pending.length === 0,
  };

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      if (!latest.current.ready) return;
      latest.current.revalidate();
    };

    const timer = setInterval(poll, intervalMs);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [intervalMs]);
}

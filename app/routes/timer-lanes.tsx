import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/timer-lanes";
import { fetchSnapshot, forgetLegacyGrant, type Snapshot } from "~/lib/timer";
import { firstStopPath } from "~/lib/timer-path";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Meet Runner" }];
}

/**
 * Standing behind a lane is the first thing that happens.
 *
 * Its own screen and its own address, reached straight off the QR code. Until
 * it's answered nothing else means anything, and once it is, the answer is in
 * the URL rather than in the device — which is what lets a volunteer swap ends
 * of the pool by going back, and what makes "which lane am I?" a question with
 * a visible answer rather than a remembered one.
 *
 * The lanes are the only thing on screen. A person who has just been handed a
 * phone and a clipboard is being asked one question, and it is a big-buttoned
 * one they can answer without reading.
 */
export default function TimerLanes({ params }: Route.ComponentProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Phones that timed a meet on the build before the grant became a cookie
    // still have the old token sitting in localStorage. Nothing reads it.
    forgetLegacyGrant();
    fetchSnapshot(params.timerId)
      .then(setSnapshot)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Couldn't load the meet."),
      );
  }, [params.timerId]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-bold">Not timing yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {error}
          </p>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <h1 className="mb-1 text-center text-xl font-bold">
        {snapshot.meet.name}
      </h1>
      <p className="mb-6 text-center text-slate-600 dark:text-slate-300">
        Which lane are you timing?
      </p>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: snapshot.meet.laneCount }, (_, i) => i + 1).map(
          (lane) => (
            <Link
              key={lane}
              to={firstStopPath(snapshot, params.meetId, params.timerId, lane)}
              className="flex min-h-24 touch-manipulation items-center justify-center rounded-2xl border-2 border-slate-300 text-4xl font-bold active:bg-blue-600 active:text-white dark:border-slate-700"
            >
              {lane}
            </Link>
          ),
        )}
      </div>
    </main>
  );
}

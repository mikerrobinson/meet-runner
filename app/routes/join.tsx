import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/join";
import { Banner, Button, Card, Field, SectionTitle, TextInput } from "~/components/ui";
import { askToJoin } from "~/lib/auth";
import { APP_HOME } from "./home";
import { describeContact } from "~/lib/identity";
import { generateId } from "~/lib/id";
import { useAppStore } from "~/state/app-store";
import { useSession } from "~/state/session";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Find your team · Meet Runner" }];
}

/**
 * Where a signed-in person with no team lands.
 *
 * Three ways out, in the order they're likely: a team that exists but nobody
 * has claimed (the seasons that predate accounts), a team that someone else
 * runs and you have to be let into, or nothing at all — in which case you're
 * starting one.
 */
export default function Join() {
  const session = useSession();
  const { startFreshTeam } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { notice?: string } };

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);

  /**
   * Leaving, in either direction.
   *
   * Signed out, there's nothing on this screen addressed to you — which is
   * also what happens right after signing out from it.
   *
   * Having a team to open is the other way out, and it's an effect rather than
   * something the join button does for itself: approval can arrive from
   * anywhere. Tapping "Check again" after a coach lets you in has to leave
   * this screen, and so does a coach admitting you while you sit here.
   */
  useEffect(() => {
    if (session.status === "out") navigate("/sign-in", { replace: true });
    else if (session.openTeamId) navigate(APP_HOME, { replace: true });
  }, [session.status, session.openTeamId, navigate]);

  const pending = session.memberships.filter((m) => m.status === "pending");
  const offered = session.joinable.filter((t) => t.status === undefined);

  if (!session.user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  const join = async (teamId: string) => {
    setBusy(teamId);
    setError(null);
    try {
      // Claiming an unheld team makes you its coach outright; asking to join a
      // held one means waiting. Either way the effect above decides where that
      // leaves you.
      session.adopt(await askToJoin(teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Register the id first, then build the team around it.
   *
   * That order matters: the team doesn't reach the server until this device
   * syncs, and an id nobody owns in the meantime is an id somebody else could
   * claim.
   */
  const startTeam = async () => {
    const teamId = generateId();
    setBusy(teamId);
    setError(null);
    try {
      const next = await askToJoin(teamId, true);
      // The team has to exist on this device before the effect above sends us
      // into it, or the shell would arrive at a season that isn't there yet.
      startFreshTeam(name.trim() || "My Team", teamId);
      session.adopt(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the team.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Find your team</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Signed in as {describeContact(session.user)}.
        </p>
      </div>

      {location.state?.notice && <Banner tone="warn">{location.state.notice}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {pending.length > 0 && (
        <Card>
          <SectionTitle>Waiting on a coach</SectionTitle>
          <ul className="space-y-2 text-sm">
            {pending.map((m) => (
              <li key={m.teamId} className="text-slate-600 dark:text-slate-300">
                You&rsquo;ve asked to join <strong>{m.name}</strong>. A coach there
                has to let you in.
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button size="sm" onClick={() => void session.refresh()}>
              Check again
            </Button>
          </div>
        </Card>
      )}

      {offered.length > 0 && (
        <Card>
          <SectionTitle>Teams on this server</SectionTitle>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {offered.map((team) => (
              <li
                key={team.teamId}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {team.name}
                    {team.code && ` (${team.code})`}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {team.athletes} athlete{team.athletes === 1 ? "" : "s"} ·{" "}
                    {team.meets} meet{team.meets === 1 ? "" : "s"}
                    {!team.claimed && " · no coach yet"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={team.claimed ? "secondary" : "primary"}
                  disabled={busy !== null}
                  onClick={() => void join(team.teamId)}
                >
                  {team.claimed ? "Ask to join" : "Claim"}
                </Button>
              </li>
            ))}
          </ul>
          {offered.some((t) => !t.claimed) && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              A team with no coach yet is one that was set up before sign-in
              existed. Claiming it makes you its head coach, and from then on
              everyone else has to be let in.
            </p>
          )}
        </Card>
      )}

      <Card>
        <SectionTitle>Start a new team</SectionTitle>
        {starting ? (
          <div className="space-y-3">
            <Field label="Team name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cactus Shadows High School"
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => void startTeam()}
              >
                Create
              </Button>
              <Button disabled={busy !== null} onClick={() => setStarting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              You&rsquo;ll be its head coach, and can invite others.
            </p>
            <div className="mt-3">
              <Button onClick={() => setStarting(true)}>New team</Button>
            </div>
          </>
        )}
      </Card>

      <div className="text-center">
        <Button size="sm" variant="ghost" onClick={() => void session.signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}

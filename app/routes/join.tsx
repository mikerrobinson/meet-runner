import { useEffect, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/join";
import { Banner, Button, Card, Field, SectionTitle, TextInput } from "~/components/ui";
import { startTeam } from "~/lib/auth";
import { APP_HOME } from "./home";
import { describeContact } from "~/lib/identity";
import { useSession } from "~/state/session";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Find your team · Meet Runner" }];
}

/**
 * Where a signed-in person with no team lands.
 *
 * Two ways out: a team nobody coaches yet — the ones that predate accounts,
 * and every school somebody typed in as an opponent — or nothing that fits, in
 * which case you're starting one.
 *
 * There is no third way, and there used to be: asking to join a team somebody
 * already coaches, and waiting to be approved. Getting onto a team that has a
 * coach is now the coach's move, exactly as it is for a meet — they add you by
 * name, or send you a link. Nobody waits on a screen for a decision that has
 * nowhere to be made.
 */
export default function Join() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { notice?: string } };

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);

  /**
   * Claiming, asked of the team's own page.
   *
   * The same `claim` intent its Coaches card submits, so there is one place
   * that decides whether a team is anybody's for the asking — reached from
   * here by naming the team in the action's URL rather than in a body.
   */
  const claiming = useFetcher<{ ok?: boolean; error?: string }>();
  const claimError = claiming.data?.ok === false ? claiming.data.error : null;

  /**
   * Leaving, in either direction.
   *
   * Signed out, there's nothing on this screen addressed to you — which is
   * also what happens right after signing out from it.
   *
   * Having a team to open is the other way out, and it's an effect rather than
   * something the buttons do for themselves: it can become true from
   * elsewhere. Tapping "Check again" after a coach has added you has to leave
   * this screen, and so does following an invite in another tab.
   */
  useEffect(() => {
    if (session.status === "out") navigate("/sign-in", { replace: true });
    else if (session.openTeamId) navigate(APP_HOME, { replace: true });
  }, [session.status, session.openTeamId, navigate]);

  // A claim that landed changes which teams this account coaches, which is
  // what the effect above is waiting on. Goes away with the provider, once the
  // session is served by a loader like everything else.
  useEffect(() => {
    if (claiming.state === "idle" && claiming.data?.ok) void session.refresh();
    // The session object is rebuilt each render; the answer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claiming.state, claiming.data]);

  // Only the unclaimed ones can be acted on from here. A team with a coach is
  // theirs to hand out, so it isn't offered.
  const offered = session.joinable.filter((team) => !team.claimed);

  if (!session.user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  /** Take on a team nobody coaches. The effect above decides where it leaves
   *  you, because it's the same answer as arriving already coaching one. */
  const claim = (teamId: string) => {
    setError(null);
    claiming.submit(
      { intent: "claim" },
      { method: "post", action: `/teams/${teamId}` },
    );
  };

  const start = async () => {
    setBusy("new");
    setError(null);
    try {
      // The server writes the team, its first season and the coach together.
      session.adopt((await startTeam(name.trim() || "My Team")).session);
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
      {(error ?? claimError) && (
        <Banner tone="error">{error ?? claimError}</Banner>
      )}

      {offered.length > 0 && (
        <Card>
          <SectionTitle
            action={
              <Button size="sm" onClick={() => void session.refresh()}>
                Check again
              </Button>
            }
          >
            Teams nobody coaches
          </SectionTitle>
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
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null || claiming.state !== "idle"}
                  onClick={() => claim(team.teamId)}
                >
                  This is mine
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            These are teams somebody raced without anyone from the school ever
            signing in. Taking one on makes you its coach, and from then on
            everyone else has to be added by a coach.
          </p>
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
                onClick={() => void start()}
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
              You&rsquo;ll be its coach, and can add others.
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

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { PersonPicker } from "./PersonPicker";
import { describeContact } from "~/lib/identity";

export interface LinkedAccount {
  userId: string;
  name: string | null;
  contact: string;
}

/**
 * Which account is this swimmer.
 *
 * The link that was missing: without it a swimmer who signs in is a spectator,
 * and the original reason this app exists — handing iPads round before a meet
 * so swimmers sort out their own entries — has no way to know whose entries
 * are whose.
 *
 * A coach does the linking, never the person themselves: a roster record is an
 * assertion about who somebody is, and letting anyone claim any swimmer would
 * make it worthless.
 *
 * The account is searched from the whole directory. It used to be picked from
 * the team's own members, back when a swimmer held a membership row of their
 * own — which meant they had to ask to join and be approved before a coach
 * could say who they were, a whole flow in front of one fact. The roster is
 * enrollments, the account is this, and neither needs anything in between.
 */
export function AthleteAccount({
  teamId,
  linked,
}: {
  teamId: string;
  /**
   * Who this swimmer is, from the page's loader — so unlinking and relinking
   * are the server's answer rather than a second copy kept in step here.
   */
  linked: LinkedAccount | null;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [picking, setPicking] = useState(false);

  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.error ?? null;

  // The sheet closes on the answer, not on the tap — an account that turns out
  // to be somebody else's swimmer is refused, and the refusal belongs where
  // the choice was made.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setPicking(false);
  }, [fetcher.state, fetcher.data]);

  const set = (userId: string) =>
    fetcher.submit(
      { intent: "link-account", teamId, userId },
      { method: "post" },
    );

  return (
    <Card>
      <SectionTitle>Account</SectionTitle>

      {error && !picking && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {linked ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            <span className="block truncate font-semibold">
              {linked.name ?? describeContact(linked)}
            </span>
            <span className="block text-xs text-slate-500">
              {linked.name && `${describeContact(linked)} · `}
              Can sign in and see their own entries.
            </span>
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => set("")}
          >
            Unlink
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No account yet.
          </p>
          <Button size="sm" onClick={() => setPicking(true)}>
            Link an account
          </Button>
        </div>
      )}

      {picking && (
        <PersonPicker
          title="Link an account"
          exclude={[]}
          busy={busy}
          error={error}
          onAppoint={(user) => set(user.userId)}
          onClose={() => setPicking(false)}
        />
      )}
    </Card>
  );
}

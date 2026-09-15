import { useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { PersonPicker } from "./PersonPicker";
import { request } from "~/lib/http";
import { describeContact } from "~/lib/identity";
import type { Athlete } from "~/types/meet";

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
  athlete,
  teamId,
  linked,
}: {
  athlete: Pick<Athlete, "id">;
  teamId: string;
  linked: LinkedAccount | null;
}) {
  const [account, setAccount] = useState(linked);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = async (person: LinkedAccount | null) => {
    setBusy(true);
    setError(null);
    try {
      await request<{ athlete: Athlete }>(
        `/api/athletes/${encodeURIComponent(athlete.id)}/link`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, userId: person?.userId }),
        },
      );
      setAccount(person);
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Account</SectionTitle>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {account ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            <span className="block truncate font-semibold">
              {account.name ?? describeContact(account)}
            </span>
            <span className="block text-xs text-slate-500">
              {account.name && `${describeContact(account)} · `}
              Can sign in and see their own entries.
            </span>
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void set(null).catch(() => {})}
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
          onAppoint={(user) =>
            set({ userId: user.userId, name: user.name, contact: user.contact })
          }
          onClose={() => setPicking(false)}
        />
      )}
    </Card>
  );
}

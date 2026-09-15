import { useCallback, useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { Banner, Button, Card, SectionTitle, TextInput } from "./ui";
import { PersonPicker } from "./PersonPicker";
import { claimTeam, createInvite } from "~/lib/auth";
import { request } from "~/lib/http";
import { describeContact } from "~/lib/identity";
import { useSession } from "~/state/session";

interface Coach {
  userId: string;
  /** Null for anyone who isn't a coach here — see the endpoint. */
  contact: string | null;
  name: string | null;
  /** Invited, but has never signed in — so the contact is still unproven. */
  pending: boolean;
}

interface Roll {
  coaches: Coach[];
  youCoachThis: boolean;
  /** Nobody coaches this team, so anyone signed in may take it on. */
  claimable: boolean;
}

interface AddResult extends Pick<Roll, "coaches"> {
  sent?: boolean;
  detail?: string;
  /** Local builds only, so an invite can be followed with no provider set up. */
  link?: string;
}

/**
 * Who coaches this team.
 *
 * The same card as `MeetAdmins`, backed by the same shape: a row in
 * `team_coaches` is the whole relationship, a team has as many coaches as it
 * needs, any of them can add another, and it cannot go down to none.
 *
 * The one thing a meet has no equivalent of is claiming. A meet is created
 * with somebody running it; a team may have nobody, because every school typed
 * in as an opponent is a team nobody has ever signed in to. An empty list is
 * that state, and it's the only time somebody can let themselves in.
 *
 * Read from the server rather than from the session, which is what lets it be
 * right the moment a team is created or claimed: the session is fetched at
 * boot, so a coach who has just taken a team on isn't in the copy this device
 * holds yet.
 */
export function TeamMembers({ teamId }: { teamId: string }) {
  const session = useSession();
  // Taking a team on, or stepping down from it, changes what the page around
  // this card may do — the loader worked that out before either happened, so
  // it has to be asked again.
  const { revalidate } = useRevalidator();

  const [roll, setRoll] = useState<Roll | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const path = `/api/teams/${encodeURIComponent(teamId)}/coaches`;

  const load = useCallback(() => {
    request<Roll>(path)
      .then(setRoll)
      .catch(() => setRoll(null));
  }, [path]);

  useEffect(load, [load]);

  if (roll === null) return null;
  const { coaches, youCoachThis, claimable } = roll;

  const add = async (body: Record<string, unknown>) => {
    const result = await request<AddResult>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setRoll({ ...roll, coaches: result.coaches });
    setAdding(false);
    setError(null);
    setNotice(
      result.link
        ? `Invitation ready. No provider is configured, so open it yourself: ${result.link}`
        : result.sent === false
          ? `They're a coach here, but nothing was sent. ${result.detail ?? ""}`.trim()
          : null,
    );
  };

  const remove = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ coaches: Coach[] }>(path, {
        method: "DELETE",
        body: JSON.stringify({ userId }),
      });
      setRoll({ ...roll, coaches: body.coaches });
      // Stepping down is allowed, and it takes the controls with it.
      load();
      if (userId === session.user?.id) {
        void session.refresh();
        void revalidate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  /** Take on a team nobody coaches. Closes behind you — see the endpoint. */
  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      session.adopt(await claimTeam(teamId));
      load();
      void revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't claim it.");
    } finally {
      setBusy(false);
    }
  };

  const makeInvite = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setInvite((await createInvite(teamId)).url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make an invitation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle
        action={
          youCoachThis ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
              + Coach
            </Button>
          ) : claimable && session.status === "in" ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void claim()}
            >
              This is my team
            </Button>
          ) : undefined
        }
      >
        Coaches
      </SectionTitle>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {notice && (
        <div className="mb-3">
          <Banner tone="warn">{notice}</Banner>
        </div>
      )}

      {coaches.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">
          Nobody coaches this team yet — it was set up by whoever raced against
          it. If you coach here, take it on and it&rsquo;s yours from then on.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {coaches.map((coach) => {
            // What to call them, in the order of how well it identifies a
            // person: their name, then the contact — which a visitor isn't
            // given — and failing both, the job itself, so a row is never
            // blank.
            const contact = coach.contact
              ? describeContact({ contact: coach.contact })
              : null;

            return (
              <li key={coach.userId} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {coach.name ?? contact ?? "Coach"}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {[
                      coach.name ? contact : null,
                      coach.pending ? "invited — hasn't signed in yet" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {youCoachThis && coaches.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(coach.userId)}
                  >
                    {coach.userId === session.user?.id ? "Step down" : "Remove"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Edits the roster and the seasons, enters this team&rsquo;s swimmers in a
        meet, and adds other coaches.
      </p>

      {youCoachThis && (
        <div className="mt-4 space-y-2">
          {invite ? (
            <>
              <Banner tone="info">
                Whoever opens this and signs in becomes a coach here. It&rsquo;s
                shown once — make another if you lose it.
              </Banner>
              <TextInput
                readOnly
                value={invite}
                onFocus={(e) => e.target.select()}
              />
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(invite)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void makeInvite()}>
              Make an invite link
            </Button>
          )}
        </div>
      )}

      {adding && (
        <PersonPicker
          title="Add a coach"
          inviteTitle="Invite a coach"
          inviteHint="We'll send a link that signs them in and opens this team."
          exclude={coaches.map((coach) => coach.userId)}
          onAppoint={(user) => add({ userId: user.userId })}
          onInvite={(contact, name) => add({ contact, name })}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

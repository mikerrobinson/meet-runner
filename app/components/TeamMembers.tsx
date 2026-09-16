import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Card, SectionTitle, TextInput } from "./ui";
import { PersonPicker } from "./PersonPicker";
import { describeContact } from "~/lib/identity";
import { useSession } from "~/state/session";
import type { TeamAccess } from "~/lib/access";

/** A coach as the page hands them over: the contact is null for a visitor. */
export interface Coach {
  userId: string;
  contact: string | null;
  name: string | null;
  /** Invited, but has never signed in — so the contact is still unproven. */
  pending: boolean;
}

/**
 * What the team's action answers with, whichever intent was used.
 *
 * One loose shape rather than the action's own union: this card shares the
 * action with the roster and the seasons, so typing it from `typeof action`
 * would mean naming those results here to read the four fields it cares about.
 */
interface CoachResult {
  ok?: boolean;
  error?: string;
  sent?: boolean;
  detail?: string;
  /** Local builds only, so an invite can be followed with no provider set up. */
  link?: string;
  /** The copyable invitation, from `invite-link`. Shown once. */
  url?: string;
  /** Set when the move changed which teams the caller coaches. */
  standingChanged?: boolean;
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
 * Rows and standing both arrive with the page, from the same request — which
 * is what lets this be right the moment a team is claimed. It used to fetch
 * the list itself and read standing from a session fetched at boot, so a coach
 * who had just taken a team on wasn't in the copy the device held yet.
 */
export function TeamMembers({
  teamId,
  coaches,
  access,
}: {
  teamId: string;
  coaches: Coach[];
  access: TeamAccess;
}) {
  const session = useSession();
  const fetcher = useFetcher<CoachResult>();
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const error = result?.error ?? null;
  const invite = result?.url ?? null;

  const youCoachThis = access.coach;
  const claimable = coaches.length === 0;

  // The sheet closes on the answer, not on the tap — so an invitation that
  // couldn't be sent still has somewhere to say so.
  useEffect(() => {
    if (fetcher.state === "idle" && result?.ok) setAdding(false);
  }, [fetcher.state, result]);

  /**
   * Tell the session provider its team list has moved.
   *
   * Claiming a team or stepping down changes which teams this account coaches,
   * which the header and the team picker read from the session rather than
   * from this page's loader. Only those two moves — adding somebody else or
   * minting a link leaves your own standing exactly where it was, and the
   * action says which is which rather than this guessing from the intent.
   *
   * Goes away with the provider itself, once the session is served by a loader
   * like everything else.
   */
  useEffect(() => {
    if (fetcher.state === "idle" && result?.standingChanged) {
      void session.refresh();
    }
    // The session object is rebuilt each render; the answer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, result]);

  const notice = result?.link
    ? `Invitation ready. No provider is configured, so open it yourself: ${result.link}`
    : result?.sent === false
      ? `They're a coach here, but nothing was sent. ${result.detail ?? ""}`.trim()
      : null;

  const submit = (fields: Record<string, string>) => {
    setCopied(false);
    fetcher.submit(fields, { method: "post", action: `/teams/${teamId}` });
  };

  return (
    <Card>
      <SectionTitle
        action={
          youCoachThis ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
              + Coach
            </Button>
          ) : claimable && access.signedIn ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => submit({ intent: "claim" })}
            >
              This is my team
            </Button>
          ) : undefined
        }
      >
        Coaches
      </SectionTitle>

      {error && !adding && (
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
                    onClick={() =>
                      submit({ intent: "coach-remove", userId: coach.userId })
                    }
                  >
                    {coach.userId === access.userId ? "Step down" : "Remove"}
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
            <Button
              size="sm"
              disabled={busy}
              onClick={() => submit({ intent: "invite-link" })}
            >
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
          busy={busy}
          error={error}
          onAppoint={(user) =>
            submit({ intent: "coach-add", userId: user.userId })
          }
          onInvite={(contact, name) =>
            submit({ intent: "coach-invite", contact, ...(name ? { name } : {}) })
          }
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { PersonPicker } from "./PersonPicker";
import type { MeetAdmin } from "~/lib/admins.server";

/**
 * What the meet's action answers with, whichever intent was used.
 *
 * Deliberately one loose shape rather than the action's own union: this card
 * shares the action with the lineup, the teams and the timing code, so typing
 * it from `typeof action` would mean naming every one of those results here
 * to read the two fields that concern it.
 */
interface AdminResult {
  ok?: boolean;
  error?: string;
  sent?: boolean;
  detail?: string;
  /** Local builds only, so an invite can be followed with no provider set up. */
  link?: string;
}

/**
 * Who runs this meet.
 *
 * Distinct from who coaches a team in it, and the distinction is the point: at
 * a dual meet both coaches are in the water's business, but only one person
 * rules on a DQ or decides which of three watches stands. That person often
 * *is* the host's coach, which is why whoever sets a meet up gets the job
 * automatically — this screen exists for the times it should be somebody else.
 *
 * The list is the relationship, the same way `MeetTeams` is: rows with a way
 * to add and a way to remove, and no notion of a single owner. A meet can have
 * as many administrators as it needs and cannot go down to none.
 *
 * Nothing is fetched here. The rows arrive with the page and the writes go to
 * the meet's own action, so the controls and the check behind them are asked
 * of the same request — and `youRunThis` is `access.admin`, the very row being
 * listed, rather than a second opinion from a second endpoint.
 */
export function MeetAdmins({
  admins,
  youRunThis,
}: {
  admins: MeetAdmin[];
  youRunThis: boolean;
}) {
  const fetcher = useFetcher<AdminResult>();
  const [adding, setAdding] = useState(false);

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const error = result?.error ?? null;

  // The sheet closes on the answer, not on the tap. Closing optimistically
  // would hide the one place an invitation that couldn't be sent gets to say
  // so, which on a build with no provider configured is every invitation.
  useEffect(() => {
    if (fetcher.state === "idle" && result?.ok) setAdding(false);
  }, [fetcher.state, result]);

  const notice =
    result?.link
      ? `Invitation ready. No provider is configured, so open it yourself: ${result.link}`
      : result?.sent === false
        ? `They're on the list, but nothing was sent. ${result.detail ?? ""}`.trim()
        : null;

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(fields, { method: "post" });

  return (
    <Card>
      <SectionTitle
        action={
          youRunThis ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
              + Admin
            </Button>
          ) : undefined
        }
      >
        Running this meet
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

      {admins.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">
          Nobody yet. Whoever first syncs this meet to the server takes it on.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {admins.map((admin) => (
            <li key={admin.userId} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {admin.name ?? admin.contact}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {admin.name ? admin.contact : null}
                  {admin.pending && (
                    <span className={admin.name ? "ml-2" : undefined}>
                      Invited — hasn&rsquo;t signed in yet
                    </span>
                  )}
                </span>
              </span>
              {youRunThis && admins.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    submit({ intent: "admin-remove", userId: admin.userId })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Sets the running order, seeds the heats, and rules on DQs and which
        watch stands. Other coaches can still enter their own swimmers and
        record times.
      </p>

      {adding && (
        <PersonPicker
          title="Add an admin"
          inviteTitle="Invite an admin"
          inviteHint="We'll send a link that signs them in and opens this meet."
          exclude={admins.map((a) => a.userId)}
          busy={busy}
          error={error}
          onAppoint={(user) =>
            submit({ intent: "admin-add", userId: user.userId })
          }
          onInvite={(contact, name) =>
            submit({ intent: "admin-invite", contact, ...(name ? { name } : {}) })
          }
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

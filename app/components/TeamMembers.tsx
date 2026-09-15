import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Select,
  TextInput,
} from "./ui";
import { PersonPicker } from "./PersonPicker";
import { createInvite, decideRequest, type PendingRequest } from "~/lib/auth";
import { request } from "~/lib/http";
import {
  INVITABLE_ROLES,
  ROLE_LABELS,
  describeContact,
  type Role,
} from "~/lib/identity";
import { useSession } from "~/state/session";

interface Coach {
  userId: string;
  /** Null for anyone who isn't a coach here — see the endpoint. */
  contact: string | null;
  name: string | null;
  role: Role;
  /** Invited, but has never signed in — so the contact is still unproven. */
  pending: boolean;
}

interface Roll {
  coaches: Coach[];
  pending: PendingRequest[];
  youCoachThis: boolean;
}

interface AddResult extends Pick<Roll, "coaches"> {
  sent?: boolean;
  detail?: string;
  /** Local builds only, so an invite can be followed with no provider set up. */
  link?: string;
}

/**
 * Who coaches this team, and who's waiting to be let on it.
 *
 * The same card as `MeetAdmins`, for the same reason: a team has as many
 * coaches as it needs, any of them can add another, and it cannot go down to
 * none. What a meet has no equivalent of is the second half — people who found
 * the team and asked to join — because a meet is something you're given and a
 * team is somewhere you belong.
 *
 * Read from the server rather than from the session, which is what lets it be
 * right the moment a team is created: the session is fetched at boot, so a
 * coach who has just made a team isn't in the copy this device holds yet.
 */
export function TeamMembers({ teamId }: { teamId: string }) {
  const session = useSession();

  const [roll, setRoll] = useState<Roll | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; role: Role } | null>(null);
  const [inviteRole, setInviteRole] = useState<Role>("athlete");
  const [copied, setCopied] = useState(false);

  const path = `/api/teams/${encodeURIComponent(teamId)}/coaches`;

  const load = useCallback(() => {
    request<Roll>(path)
      .then(setRoll)
      .catch(() => setRoll(null));
  }, [path]);

  useEffect(load, [load]);

  if (roll === null) return null;
  const { coaches, pending, youCoachThis } = roll;

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
      if (userId === session.user?.id) void session.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (userId: string, admit: boolean, role?: Role) => {
    setBusy(true);
    setError(null);
    try {
      session.adopt(await decideRequest(teamId, userId, admit, role));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const makeInvite = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const made = await createInvite(teamId, inviteRole);
      setInvite({ url: made.url, role: made.role });
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
          Nobody has claimed this team yet. The first coach to ask for it gets
          it, and from then on everyone else has to be let in.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {coaches.map((coach) => {
            // What to call them, in the order of how well it identifies a
            // person: their name, then the contact — which a visitor isn't
            // given — and failing both, the job itself, so a row is never
            // blank and never reads "Coach · Coach".
            const contact = coach.contact
              ? describeContact({ contact: coach.contact })
              : null;
            const named = coach.name ?? contact;

            return (
              <li key={coach.userId} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {named ?? ROLE_LABELS[coach.role]}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {[
                      named ? ROLE_LABELS[coach.role] : null,
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
        meet, and lets other people on.
      </p>

      {youCoachThis && pending.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-bold text-slate-600 dark:text-slate-300">
            Waiting to join
          </h3>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {pending.map((person) => (
              <li key={person.userId} className="py-2">
                <p className="truncate font-semibold">
                  {person.name ?? describeContact(person)}
                </p>
                {person.name && (
                  <p className="truncate text-xs text-slate-500">
                    {describeContact(person)}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {INVITABLE_ROLES.map((role) => (
                    <Button
                      key={role}
                      size="sm"
                      disabled={busy}
                      onClick={() => void decide(person.userId, true, role)}
                    >
                      {ROLE_LABELS[role]}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void decide(person.userId, false)}
                  >
                    Turn down
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {youCoachThis && (
        <div className="mt-4 space-y-2">
          <Field
            label="Invite a swimmer, parent or viewer"
            hint="A one-time link, good for a fortnight. Whoever opens it and signs in joins with this role. Coaches are added above, by name."
          >
            <Select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={busy} onClick={() => void makeInvite()}>
            Make a link
          </Button>

          {invite && (
            <div className="space-y-2">
              <Banner tone="info">
                Anyone who opens this joins as{" "}
                {ROLE_LABELS[invite.role].toLowerCase()}. It&rsquo;s shown once —
                make another if you lose it.
              </Banner>
              <TextInput
                readOnly
                value={invite.url}
                onFocus={(e) => e.target.select()}
              />
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(invite.url)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          )}
        </div>
      )}

      {adding && (
        <PersonPicker
          title="Add a coach"
          inviteTitle="Invite a coach"
          inviteHint="We'll send a link that signs them in and opens this team."
          exclude={coaches.map((coach) => coach.userId)}
          onAppoint={(userId) => add({ userId })}
          onInvite={(contact, name) => add({ contact, name })}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

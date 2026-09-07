import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Banner, Button, Card, Field, SectionTitle, Select, TextInput } from "./ui";
import {
  createInvite,
  decideRequest,
  listPending,
  type PendingRequest,
} from "~/lib/auth";
import {
  INVITABLE_ROLES,
  ROLE_LABELS,
  canAdmit,
  describeContact,
  type Role,
} from "~/lib/identity";
import { useAppStore } from "~/state/app-store";
import { useSession } from "~/state/session";

/**
 * The account, as far as anyone needs to see it.
 *
 * Who you are, what you are on this team, who's waiting to be let in, and a
 * link to hand someone else. Everything here is a coach's business; an athlete
 * or a parent will get a much shorter version of this card when those roles
 * arrive.
 */
export function AccountPanel() {
  const session = useSession();
  const { team } = useAppStore();

  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; role: Role } | null>(null);
  const [inviteRole, setInviteRole] = useState<Role>("coach");
  const [copied, setCopied] = useState(false);

  const membership = session.memberships.find((m) => m.teamId === team.id);
  const coach = canAdmit(membership);

  const refreshPending = useCallback(() => {
    if (!coach) return;
    listPending(team.id)
      .then(setPending)
      .catch(() => setPending([]));
  }, [coach, team.id]);

  useEffect(refreshPending, [refreshPending]);

  if (session.status === "out") {
    return (
      <Card>
        <SectionTitle>Account</SectionTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This device isn&rsquo;t signed in. The season here still works and still
          syncs, but the server doesn&rsquo;t know whose it is.
        </p>
        <div className="mt-3">
          <Link to="/sign-in">
            <Button variant="primary">Sign in</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const decide = async (userId: string, admit: boolean, role?: Role) => {
    setBusy(true);
    setError(null);
    try {
      session.adopt(await decideRequest(team.id, userId, admit, role));
      setPending((current) => current.filter((p) => p.userId !== userId));
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
      const made = await createInvite(team.id, inviteRole);
      setInvite({ url: made.url, role: made.role });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make an invitation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Account</SectionTitle>

      <p className="text-sm text-slate-600 dark:text-slate-300">
        Signed in as <strong>{session.user && describeContact(session.user)}</strong>
        {membership && ` — ${ROLE_LABELS[membership.role].toLowerCase()} of ${team.name}`}.
        {session.stale && " (last known; the server is unreachable right now)"}
      </p>

      {session.user && (
        <p className="mt-1 text-sm">
          <Link
            to={`/users/${session.user.id}`}
            className="font-semibold text-blue-600"
          >
            Your teams, meets and times ›
          </Link>
        </p>
      )}

      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {coach && pending.length > 0 && (
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

      {coach && (
        <div className="mt-4 space-y-2">
          <Field
            label="Invite someone"
            hint="A one-time link, good for a fortnight. Whoever opens it and signs in joins with this role."
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
                Anyone who opens this joins as {ROLE_LABELS[invite.role].toLowerCase()}.
                It&rsquo;s shown once — make another if you lose it.
              </Banner>
              <TextInput readOnly value={invite.url} onFocus={(e) => e.target.select()} />
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(invite.url).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void session.signOut()}>
          Sign out
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void session.signOut(true)}
        >
          Sign out everywhere
        </Button>
      </div>
    </Card>
  );
}

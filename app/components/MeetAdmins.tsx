import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, Field, Sheet, TextInput } from "./ui";
import { SectionTitle } from "./ui";
import { request } from "~/lib/http";

interface Admin {
  userId: string;
  contact: string;
  name: string | null;
  pending: boolean;
}

interface DirectoryUser {
  userId: string;
  name: string | null;
  contact: string;
  pending: boolean;
}

interface AddResult {
  admins: Admin[];
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
 */
export function MeetAdmins({ meetId }: { meetId: string }) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [youRunThis, setYouRunThis] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    request<{ admins: Admin[]; youRunThis: boolean }>(
      `/api/meets/${encodeURIComponent(meetId)}/admins`,
    )
      .then((body) => {
        setAdmins(body.admins);
        setYouRunThis(body.youRunThis);
      })
      .catch(() => setAdmins([]));
  }, [meetId]);

  useEffect(load, [load]);

  const remove = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ admins: Admin[] }>(
        `/api/meets/${encodeURIComponent(meetId)}/admins`,
        { method: "DELETE", body: JSON.stringify({ userId }) },
      );
      setAdmins(body.admins);
      // Stepping down is allowed, and it takes the controls with it.
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const added = (result: AddResult) => {
    setAdmins(result.admins);
    setAdding(false);
    setError(null);
    setNotice(
      result.link
        ? `Invitation ready. No provider is configured, so open it yourself: ${result.link}`
        : result.sent === false
          ? `They're on the list, but nothing was sent. ${result.detail ?? ""}`.trim()
          : null,
    );
  };

  if (admins === null) return null;

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
                  onClick={() => void remove(admin.userId)}
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
        <AdminPicker
          meetId={meetId}
          exclude={admins.map((a) => a.userId)}
          onAdded={added}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

/**
 * Finding the person, or inviting them.
 *
 * Search first, invite only once nothing matches — the same ordering as
 * `TeamPicker`, and for the same reason: two accounts for one referee is the
 * failure worth designing against, and a sheet that made inviting easier than
 * finding would cause it one meet at a time.
 *
 * Nothing is listed until something is typed. The directory spans every
 * account on the server rather than one team's members, because a meet
 * belongs to no team — so the list has to be searched, not browsed.
 */
function AdminPicker({
  meetId,
  exclude,
  onAdded,
  onClose,
}: {
  meetId: string;
  exclude: string[];
  onAdded: (result: AddResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<DirectoryUser[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = query.trim();

  // Debounced, because this fires per keystroke against a table that will
  // outgrow the meet it's being searched from.
  useEffect(() => {
    if (typed.length < 2) {
      setFound(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      request<{ users: DirectoryUser[] }>(
        `/api/users?q=${encodeURIComponent(typed)}`,
      )
        .then((body) => setFound(body.users))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [typed]);

  const candidates = (found ?? []).filter((u) => !exclude.includes(u.userId));

  const appoint = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await request<AddResult>(
          `/api/meets/${encodeURIComponent(meetId)}/admins`,
          { method: "POST", body: JSON.stringify({ userId }) },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="Add an admin" onClose={onClose}>
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        <Field
          label="Find someone"
          hint="Search by name, email or mobile number."
        >
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or contact"
            autoFocus
          />
        </Field>

        {typed.length < 2 ? (
          <p className="text-sm text-slate-500">
            Type at least two characters.
          </p>
        ) : searching ? (
          <p className="text-sm text-slate-500">Searching…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nobody here matches “{typed}”.
          </p>
        ) : (
          <ul className="max-h-56 overflow-y-auto">
            {candidates.map((user) => (
              <li key={user.userId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void appoint(user.userId)}
                  className="flex w-full items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-900"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {user.name ?? user.contact}
                    </span>
                    {user.name && (
                      <span className="block truncate text-xs text-slate-500">
                        {user.contact}
                      </span>
                    )}
                  </span>
                  {user.pending && (
                    <span className="shrink-0 text-xs text-slate-500">
                      Invited
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <Button full onClick={() => setInviting(true)} disabled={busy}>
          Invite someone new
        </Button>
        <Button full variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>

      {inviting && (
        <NewAdminSheet
          meetId={meetId}
          // What was typed is very often the address they were about to send
          // to, so it carries over rather than being typed twice.
          initial={typed}
          onAdded={onAdded}
          onClose={() => setInviting(false)}
        />
      )}
    </Sheet>
  );
}

/**
 * Somebody who has never used the app.
 *
 * A name and one way to reach them, which is exactly what an account is made
 * of — so this creates one, appoints it, and sends the link that proves the
 * contact. They are an administrator from this moment; signing in is how they
 * take it up, not how they are granted it.
 *
 * Typing an address that turns out to belong to an existing account appoints
 * that account instead of minting a second, so getting this wrong is cheap.
 */
function NewAdminSheet({
  meetId,
  initial,
  onAdded,
  onClose,
}: {
  meetId: string;
  initial: string;
  onAdded: (result: AddResult) => void;
  onClose: () => void;
}) {
  // Whatever was being searched for is a contact if it looks like one, and a
  // name otherwise.
  const looksLikeContact = /[@\d]/.test(initial);
  const [name, setName] = useState(looksLikeContact ? "" : initial);
  const [contact, setContact] = useState(looksLikeContact ? initial : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!contact.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await request<AddResult>(
          `/api/meets/${encodeURIComponent(meetId)}/admins`,
          {
            method: "POST",
            body: JSON.stringify({
              contact: contact.trim(),
              name: name.trim() || undefined,
            }),
          },
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't invite them.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="Invite an admin" onClose={onClose}>
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dana Kerr"
            autoCapitalize="words"
            autoFocus={!name}
          />
        </Field>

        <Field
          label="Email or mobile"
          hint="We'll send a link that signs them in and opens this meet."
        >
          <TextInput
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="dana@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        <Button
          full
          variant="primary"
          disabled={busy || !contact.trim()}
          onClick={() => void save()}
        >
          {busy ? "Sending…" : "Send invitation"}
        </Button>
        <Button full variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { PersonPicker } from "./PersonPicker";
import { request } from "~/lib/http";

interface Admin {
  userId: string;
  contact: string;
  name: string | null;
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

  const path = `/api/meets/${encodeURIComponent(meetId)}/admins`;

  const load = useCallback(() => {
    request<{ admins: Admin[]; youRunThis: boolean }>(path)
      .then((body) => {
        setAdmins(body.admins);
        setYouRunThis(body.youRunThis);
      })
      .catch(() => setAdmins([]));
  }, [path]);

  useEffect(load, [load]);

  const remove = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ admins: Admin[] }>(path, {
        method: "DELETE",
        body: JSON.stringify({ userId }),
      });
      setAdmins(body.admins);
      // Stepping down is allowed, and it takes the controls with it.
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const add = async (body: Record<string, unknown>) => {
    const result = await request<AddResult>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
        <PersonPicker
          title="Add an admin"
          inviteTitle="Invite an admin"
          inviteHint="We'll send a link that signs them in and opens this meet."
          exclude={admins.map((a) => a.userId)}
          onAppoint={(user) => add({ userId: user.userId })}
          onInvite={(contact, name) => add({ contact, name })}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { request } from "~/lib/http";
import type { Athlete } from "~/types/meet";

interface Member {
  userId: string;
  contact: string;
  name: string | null;
  role: string;
}

/**
 * Which account is this swimmer.
 *
 * The link that was missing: without it a swimmer who signs in is a spectator,
 * and the original reason this app exists — handing iPads round before a meet
 * so swimmers sort out their own entries — has no way to know whose entries
 * are whose.
 *
 * A coach does the linking, from the list of people already admitted to the
 * team. Self-claiming would let anyone assert they were anyone.
 */
export function AthleteAccount({
  athlete,
  teamId,
  onLinked,
}: {
  athlete: Athlete;
  teamId: string;
  onLinked: (athlete: Athlete) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null while we don't know — a viewer who isn't a coach never finds out. */
  const [allowed, setAllowed] = useState<boolean | null>(null);

  const load = useCallback(() => {
    request<{ members: Member[] }>(
      `/api/members?teamId=${encodeURIComponent(teamId)}`,
    )
      .then((body) => {
        setMembers(body.members);
        setAllowed(true);
      })
      .catch(() => setAllowed(false));
  }, [teamId]);

  useEffect(load, [load]);

  const linked = members?.find((m) => m.userId === athlete.userId);

  const set = async (userId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ athlete: Athlete }>(
        `/api/athletes/${encodeURIComponent(athlete.id)}/link`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, userId: userId ?? undefined }),
        },
      );
      onLinked(body.athlete);
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  // Nothing useful to show someone who can't change it, and the member list —
  // which is contact details — never loaded for them anyway.
  if (allowed === false && !athlete.userId) return null;

  return (
    <Card>
      <SectionTitle>Account</SectionTitle>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {athlete.userId ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            <span className="block truncate font-semibold">
              {linked?.name ?? linked?.contact ?? "Linked account"}
            </span>
            <span className="block text-xs text-slate-500">
              Can sign in and see their own entries.
            </span>
          </p>
          {allowed && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void set(null)}
            >
              Unlink
            </Button>
          )}
        </div>
      ) : !picking ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No account yet.
          </p>
          <Button size="sm" onClick={() => setPicking(true)}>
            Link an account
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {members === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nobody else is on this team yet. People appear here once they ask
              to join and you let them in.
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {members.map((member) => (
                <li key={member.userId}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void set(member.userId)}
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-900"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {member.name ?? member.contact}
                      </span>
                      {member.name && (
                        <span className="block truncate text-xs text-slate-500">
                          {member.contact}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {member.role.replace("_", " ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button full onClick={() => setPicking(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}

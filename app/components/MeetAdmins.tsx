import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { request } from "~/lib/http";

interface Admin {
  userId: string;
  contact: string;
  name: string | null;
}

interface Member {
  userId: string;
  contact: string;
  name: string | null;
  role: string;
}

/**
 * Who runs this meet.
 *
 * Distinct from who coaches a team in it, and the distinction is the point: at
 * a dual meet both coaches are in the water's business, but only one person
 * rules on a DQ or decides which of three watches stands. That person often
 * *is* the host's coach, which is why whoever sets a meet up gets the job
 * automatically — this screen exists for the times it should be somebody else.
 */
export function MeetAdmins({
  meetId,
  teamId,
}: {
  meetId: string;
  /** Where candidates come from: the people on this device's team. */
  teamId: string;
}) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [youRunThis, setYouRunThis] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const openPicker = () => {
    setAdding(true);
    setError(null);
    if (members === null) {
      request<{ members: Member[] }>(
        `/api/members?teamId=${encodeURIComponent(teamId)}`,
      )
        .then((body) => setMembers(body.members))
        .catch(() => setMembers([]));
    }
  };

  const change = async (userId: string, method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ admins: Admin[] }>(
        `/api/meets/${encodeURIComponent(meetId)}/admins`,
        { method, body: JSON.stringify({ userId }) },
      );
      setAdmins(body.admins);
      setAdding(false);
      // Stepping down is allowed, and it takes the controls with it.
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (admins === null) return null;

  const candidates = (members ?? []).filter(
    (m) => !admins.some((a) => a.userId === m.userId),
  );

  return (
    <Card>
      <SectionTitle
        action={
          youRunThis && !adding ? (
            <Button size="sm" onClick={openPicker}>
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

      {admins.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nobody yet. Whoever first syncs this meet to the server takes it on.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {admins.map((admin) => (
            <li key={admin.userId} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {admin.name ?? admin.contact}
              </span>
              {youRunThis && admins.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void change(admin.userId, "DELETE")}
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
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          {members === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nobody else on your team to add. They have to be on a team and
              signed in first.
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {candidates.map((member) => (
                <li key={member.userId}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void change(member.userId, "POST")}
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-900"
                  >
                    <span className="min-w-0 truncate font-medium">
                      {member.name ?? member.contact}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {member.role.replace("_", " ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button full onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}

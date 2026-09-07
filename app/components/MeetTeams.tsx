import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, SectionTitle, TextInput } from "./ui";
import { request } from "~/lib/http";
import type { PublicTeam } from "~/lib/public";
import type { MeetDoc } from "~/types/meet";

/**
 * Who's racing.
 *
 * This is the field that replaced a comma-separated list of team names, and
 * the difference is the whole point of the model change: a team here is a
 * reference, so both schools open the same meet, a visiting swimmer belongs to
 * a real roster, and "Horizon", "horizon" and "Horzion" can't become three
 * different opponents.
 *
 * Adding one offers what the server already knows before offering to make
 * something new, because the common case by a distance is racing a team that
 * is already in there.
 */
export function MeetTeams({
  meet,
  homeTeamId,
  onChange,
}: {
  meet: MeetDoc;
  /** This device's own team. Always racing, and never removable. */
  homeTeamId: string;
  onChange: (patch: { teamIds: string[]; hostTeamId?: string }) => void;
}) {
  const [known, setKnown] = useState<PublicTeam[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    request<{ teams: PublicTeam[] }>("/api/teams")
      .then((body) => setKnown(body.teams))
      .catch(() => setKnown([]));
  }, []);

  useEffect(load, [load]);

  const nameOf = (id: string) =>
    known?.find((team) => team.id === id)?.name ??
    (id === homeTeamId ? "This team" : "Another team");

  const attach = (teamId: string) => {
    if (meet.teamIds.includes(teamId)) return;
    onChange({ teamIds: [...meet.teamIds, teamId] });
    setAdding(false);
    setFilter("");
  };

  const detach = (teamId: string) => {
    onChange({
      teamIds: meet.teamIds.filter((id) => id !== teamId),
      // A host that's no longer racing isn't the host.
      hostTeamId: meet.hostTeamId === teamId ? undefined : meet.hostTeamId,
    });
  };

  const create = async () => {
    const name = filter.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const body = await request<{ team: PublicTeam }>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setKnown((current) =>
        current && !current.some((t) => t.id === body.team.id)
          ? [...current, body.team]
          : current,
      );
      attach(body.team.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't add that team. You may need to sign in.",
      );
    } finally {
      setBusy(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const candidates = (known ?? []).filter(
    (team) =>
      !meet.teamIds.includes(team.id) &&
      (!needle ||
        team.name.toLowerCase().includes(needle) ||
        team.code.toLowerCase().includes(needle)),
  );
  const exactMatch = (known ?? []).some(
    (team) => team.name.toLowerCase() === needle,
  );

  return (
    <Card>
      <SectionTitle
        action={
          !adding ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              + Team
            </Button>
          ) : undefined
        }
      >
        Teams racing
      </SectionTitle>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {meet.teamIds.map((teamId) => (
          <li key={teamId} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{nameOf(teamId)}</span>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    teamIds: meet.teamIds,
                    hostTeamId: meet.hostTeamId === teamId ? undefined : teamId,
                  })
                }
                className="text-xs font-semibold text-blue-600"
              >
                {meet.hostTeamId === teamId ? "Host pool ✓" : "Set as host"}
              </button>
            </span>
            {teamId !== homeTeamId && (
              <Button size="sm" variant="ghost" onClick={() => detach(teamId)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>

      {meet.teamIds.length === 0 && (
        <p className="py-2 text-sm text-slate-500">
          Nobody yet. A meet needs at least one team.
        </p>
      )}

      {adding && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <TextInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search, or type a new team's name…"
            autoCapitalize="words"
            autoFocus
          />

          {known === null ? (
            <p className="text-sm text-slate-500">Loading teams…</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {candidates.map((team) => (
                <li key={team.id}>
                  <button
                    type="button"
                    onClick={() => attach(team.id)}
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-900"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{team.name}</span>
                      <span className="block text-xs text-slate-500">
                        {team.athletes} athlete{team.athletes === 1 ? "" : "s"}
                        {!team.claimed && " · unclaimed"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              disabled={!filter.trim() || busy || exactMatch}
              onClick={() => void create()}
            >
              {exactMatch ? "Already listed" : `Create “${filter.trim() || "…"}”`}
            </Button>
            <Button
              onClick={() => {
                setAdding(false);
                setFilter("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            A team you create is unclaimed until a coach from that school signs
            in and asks for it.
          </p>
        </div>
      )}
    </Card>
  );
}

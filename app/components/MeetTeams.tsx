import { useMemo, useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { TeamPicker } from "./TeamPicker";
import { enrollmentIndex } from "~/lib/roster";
import type { MeetDetail } from "~/types/meet";

/**
 * Who's racing.
 *
 * This is the field that replaced a comma-separated list of team names, and
 * the difference is the whole point of the model change: a team here is a
 * reference, so both schools open the same meet, a visiting swimmer belongs to
 * a real roster, and "Horizon", "horizon" and "Horzion" can't become three
 * different opponents.
 *
 * The names come from the loader rather than a fetch of their own. `detail`
 * already carries the racing teams — it has to, because the entries grid draws
 * its rows from their rosters — and a second opinion about which teams those
 * are is exactly the kind of disagreement this rewrite existed to remove.
 */
export function MeetTeams({
  detail,
  canEdit,
  coachOf,
  saving,
  onChange,
}: {
  detail: MeetDetail;
  /** Whether to draw the editing controls at all. The server re-checks. */
  canEdit: boolean;
  /** Racing teams this person coaches — labelled, so their own is obvious. */
  coachOf: string[];
  saving: boolean;
  /** The complete resulting list, which is what `updateMeet` writes. */
  onChange: (next: { teamIds: string[]; hostTeamId: string }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const { meet, teams } = detail;
  const hostTeamId = meet.hostTeamId ?? "";

  /**
   * How many swimmers each team has entered.
   *
   * Removing a team doesn't remove its entries — the rows stay, pointing at
   * athletes no racing team enrols, which is the "counts towards things and
   * renders nowhere" failure. Nothing here deletes them either; it just
   * refuses to let it happen silently.
   */
  const enteredBy = useMemo(() => {
    const enrolled = enrollmentIndex(detail.enrollments);
    const entered = new Set(Object.values(detail.entries).flat());
    const counts = new Map<string, number>();
    for (const athleteId of entered) {
      const teamId = enrolled.get(athleteId)?.teamId;
      if (teamId) counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
    return counts;
  }, [detail.enrollments, detail.entries]);

  const teamIds = teams.map((team) => team.id);

  const add = (teamId: string) => {
    if (teamIds.includes(teamId)) return;
    onChange({
      teamIds: [...teamIds, teamId],
      // The first team on a meet is very likely the pool it's swum in.
      hostTeamId: hostTeamId || teamId,
    });
    setAdding(false);
  };

  const remove = (teamId: string) => {
    onChange({
      teamIds: teamIds.filter((id) => id !== teamId),
      // A team that isn't racing isn't the host.
      hostTeamId: hostTeamId === teamId ? "" : hostTeamId,
    });
    setConfirming(null);
  };

  const setHost = (teamId: string) => {
    onChange({
      teamIds,
      hostTeamId: hostTeamId === teamId ? "" : teamId,
    });
  };

  return (
    <Card>
      <SectionTitle
        action={
          canEdit && !adding ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={saving}>
              + Team
            </Button>
          ) : undefined
        }
      >
        Teams racing
      </SectionTitle>

      {teams.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">
          Nobody yet.{" "}
          {canEdit
            ? "A meet needs at least one team before anybody can be entered."
            : "Whoever runs this meet hasn't said who's racing."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {teams.map((team) => {
            const entered = enteredBy.get(team.id) ?? 0;
            const host = hostTeamId === team.id;
            return (
              <li key={team.id} className="py-2.5">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {team.name}
                      {team.code && (
                        <span className="ml-2 text-xs font-normal text-slate-500">
                          {team.code}
                        </span>
                      )}
                      {coachOf.includes(team.id) && (
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                          yours
                        </span>
                      )}
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => setHost(team.id)}
                        className="text-xs font-semibold text-blue-600 disabled:opacity-50"
                      >
                        {host ? "Host pool ✓" : "Set as host"}
                      </button>
                    ) : (
                      host && (
                        <span className="text-xs text-slate-500">Host pool</span>
                      )
                    )}
                    {entered > 0 && (
                      <span className="ml-2 text-xs text-slate-500">
                        {entered} entered
                      </span>
                    )}
                  </span>

                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() =>
                        entered > 0 ? setConfirming(team.id) : remove(team.id)
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>

                {/* Asked rather than prevented: sometimes the wrong school
                    really was added and its entries are the mistake too. */}
                {confirming === team.id && (
                  <div className="mt-2 space-y-2">
                    <Banner tone="warn">
                      {team.name} has {entered} swimmer
                      {entered === 1 ? "" : "s"} entered. Removing the team
                      leaves those entries in the meet with nobody to show them
                      against — scratch them first if they shouldn&rsquo;t
                      count.
                    </Banner>
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={() => setConfirming(null)}>Keep</Button>
                      <Button
                        variant="danger"
                        onClick={() => remove(team.id)}
                      >
                        Remove anyway
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <TeamPicker
            exclude={teamIds}
            onPick={(team) => add(team.id)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
    </Card>
  );
}

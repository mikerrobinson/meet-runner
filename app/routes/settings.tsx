import { useRef, useState } from "react";
import type { Route } from "./+types/settings";
import { AccountPanel } from "~/components/AccountPanel";
import { SyncPanel } from "~/components/SyncPanel";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Segmented,
  Select,
  TextInput,
} from "~/components/ui";
import { downloadFile } from "~/lib/csv";
import { normalizeAthlete, parseMeetDoc, parseTeamDoc } from "~/lib/documents";
import {
  currentSeason,
  enrollmentsIn,
  isGraduating,
  nextSeasonName,
  rosterFor,
} from "~/lib/roster";
import { useAppStore } from "~/state/app-store";
import {
  displayName,
  type Athlete,
  type MeetDoc,
  type NameOrder,
  type TeamDoc,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Settings · Meet Runner" }];
}

/** What a whole-season backup file looks like. */
interface Backup {
  kind: "meet-runner-backup";
  exportedAt: string;
  team: TeamDoc;
  /**
   * Everyone the backup refers to. Separate from the team because an athlete
   * belongs to no team — a meet against another school puts their swimmers in
   * here too, and restoring must not graft them onto our roster.
   */
  athletes: Athlete[];
  meets: MeetDoc[];
}

export default function Settings() {
  const {
    team,
    athletes,
    meets,
    setTeamInfo,
    renameSeason,
    setCurrentSeason,
    startSeason,
    replaceTeam,
    replaceAthletes,
    replaceMeet,
  } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [newSeason, setNewSeason] = useState<string | null>(null);

  const season = currentSeason(team);
  const roster = rosterFor(athletes, team, season?.id);
  // Show the setting against a real name where there is one.
  const sample = roster[0] ?? athletes[0];
  const example = sample
    ? displayName(sample, team.nameOrder)
    : displayName(
        { id: "", firstName: "Avery", lastName: "Aaronson", gender: "F" },
        team.nameOrder,
      );

  // What starting the next season would do, so the button can say so.
  const carrying = season
    ? enrollmentsIn(team, season.id).filter((e) => e.status === "active")
    : [];
  const graduating = carrying.filter((e) => isGraduating(e.year));
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleImport = async (file: File) => {
    setError(null);
    setMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Backup>;
      const nextTeam = parseTeamDoc(parsed.team);
      if (!nextTeam) throw new Error("That file has no team in it.");

      const nextAthletes = (parsed.athletes ?? []).map((a) =>
        normalizeAthlete(a as Partial<Athlete>),
      );

      const nextMeets = (parsed.meets ?? [])
        .map((m) => parseMeetDoc(m, nextTeam.id))
        .filter((m): m is MeetDoc => m !== null);

      // Nothing to mark: the next sync compares the season against what the
      // server last agreed to, and an imported document differs by content.
      replaceTeam(nextTeam);
      replaceAthletes(nextAthletes);
      for (const meet of nextMeets) replaceMeet(meet);
      setMessage(
        `Restored ${nextAthletes.length} swimmers and ${nextMeets.length} meet${
          nextMeets.length === 1 ? "" : "s"
        }.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
    }
  };

  const exportBackup = () => {
    const backup: Backup = {
      kind: "meet-runner-backup",
      exportedAt: new Date().toISOString(),
      team,
      athletes,
      meets,
    };
    downloadFile(
      `${team.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${season?.name ?? "season"}.json`,
      JSON.stringify(backup, null, 2),
      "application/json",
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Team</SectionTitle>
        <div className="space-y-3">
          <Field label="Team name" hint="Shown in the header and on exports.">
            <TextInput
              value={team.name}
              onChange={(e) => setTeamInfo({ name: e.target.value })}
              autoCapitalize="words"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" hint="Short form on heat sheets and exports.">
              <TextInput
                value={team.code}
                onChange={(e) => setTeamInfo({ code: e.target.value })}
                placeholder="CHAP"
                autoCapitalize="characters"
              />
            </Field>
            <Field label="Head coach">
              <TextInput
                value={team.headCoach ?? ""}
                onChange={(e) =>
                  setTeamInfo({ headCoach: e.target.value || undefined })
                }
                autoCapitalize="words"
              />
            </Field>
          </div>
          <Field
            label="Name order"
            hint={`Sorts and writes names this way on the roster, registration and run screens. The other name breaks ties, so siblings always come out in the same order. Example: ${example}.`}
          >
            <Segmented
              value={team.nameOrder}
              onChange={(value) => setTeamInfo({ nameOrder: value as NameOrder })}
              options={[
                { value: "last" as NameOrder, label: "Last, First" },
                { value: "first" as NameOrder, label: "First Last" },
              ]}
            />
          </Field>
        </div>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {roster.length} on the roster · {meets.length} meet
          {meets.length === 1 ? "" : "s"}
        </p>
      </Card>

      <Card>
        <SectionTitle>Season</SectionTitle>
        <div className="space-y-3">
          {team.seasons.length > 1 && (
            <Field
              label="Working in"
              hint="Which season the roster screen shows. A meet always uses the season its own date falls in."
            >
              <Select
                value={team.currentSeasonId}
                onChange={(e) => setCurrentSeason(e.target.value)}
              >
                {team.seasons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {season && (
            <Field label="Name">
              <TextInput
                value={season.name}
                onChange={(e) => renameSeason(season.id, e.target.value)}
                placeholder="2026-27"
              />
            </Field>
          )}
        </div>

        {newSeason === null ? (
          <Button
            className="mt-3"
            full
            onClick={() => setNewSeason(nextSeasonName(season?.name ?? ""))}
          >
            Start a new season
          </Button>
        ) : (
          <div className="mt-3 space-y-2">
            <Banner tone="warn">
              Carries {carrying.length - graduating.length} athlete
              {carrying.length - graduating.length === 1 ? "" : "s"} into the
              new season with their year advanced
              {graduating.length > 0 &&
                `, and leaves ${graduating.length} final-year swimmer${
                  graduating.length === 1 ? "" : "s"
                } behind`}
              . Nobody is deleted, and {season?.name ?? "this season"} keeps its
              roster and results exactly as they are.
            </Banner>
            <TextInput
              value={newSeason}
              onChange={(e) => setNewSeason(e.target.value)}
              placeholder="2027-28"
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                disabled={!newSeason.trim()}
                onClick={() => {
                  startSeason(newSeason.trim());
                  setMessage(`Now working in ${newSeason.trim()}.`);
                  setNewSeason(null);
                }}
              >
                Start {newSeason.trim() || "season"}
              </Button>
              <Button onClick={() => setNewSeason(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <AccountPanel />

      <SyncPanel />

      <Card>
        <SectionTitle>Backup</SectionTitle>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          One file with the roster and every meet — separate from server sync,
          and useful before a big change.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={exportBackup}>Export season</Button>
          <Button onClick={() => fileInput.current?.click()}>Import file</Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImport(file);
            e.target.value = "";
          }}
        />
        {message && (
          <div className="mt-3">
            <Banner tone="success">{message}</Banner>
          </div>
        )}
        {error && (
          <div className="mt-3">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
      </Card>
    </div>
  );
}

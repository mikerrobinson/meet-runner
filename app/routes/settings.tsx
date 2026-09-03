import { useRef, useState } from "react";
import type { Route } from "./+types/settings";
import { SyncPanel } from "~/components/SyncPanel";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Segmented,
  TextInput,
} from "~/components/ui";
import { downloadFile } from "~/lib/csv";
import { migrateMeet, migrateTeam } from "~/lib/documents";
import { useAppStore } from "~/state/app-store";
import { displayName, type MeetDoc, type NameOrder, type TeamDoc } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Settings · Meet Runner" }];
}

/** What a whole-season backup file looks like. */
interface Backup {
  kind: "meet-runner-backup";
  exportedAt: string;
  team: TeamDoc;
  meets: MeetDoc[];
}

export default function Settings() {
  const { team, meets, setTeamInfo, replaceTeam, replaceMeet } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  // Show the setting against a real name where there is one.
  const sample = team.swimmers.find((sw) => !sw.archived);
  const example = sample
    ? displayName(sample, team.nameOrder)
    : displayName(
        {
          id: "",
          firstName: "Avery",
          lastName: "Aaronson",
          gender: "F",
          year: "",
          archived: false,
        },
        team.nameOrder,
      );
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleImport = async (file: File) => {
    setError(null);
    setMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Backup>;
      const nextTeam = migrateTeam(parsed.team);
      if (!nextTeam) throw new Error("That file has no team in it.");

      const nextMeets = (parsed.meets ?? [])
        .map((m) => migrateMeet(m, nextTeam.id))
        .filter((m): m is MeetDoc => m !== null);

      // Treat everything as unsynced so the restored copy gets pushed up.
      replaceTeam({ ...nextTeam, syncedAt: null });
      for (const meet of nextMeets) replaceMeet({ ...meet, syncedAt: null });
      setMessage(
        `Restored ${nextTeam.swimmers.length} swimmers and ${nextMeets.length} meet${
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
      meets,
    };
    downloadFile(
      `${team.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${team.season}.json`,
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
          <Field label="Season">
            <TextInput
              value={team.season}
              onChange={(e) => setTeamInfo({ season: e.target.value })}
              placeholder="2026-27"
            />
          </Field>
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
          {team.swimmers.filter((s) => !s.archived).length} on the roster ·{" "}
          {meets.length} meet{meets.length === 1 ? "" : "s"} this season
        </p>
      </Card>

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

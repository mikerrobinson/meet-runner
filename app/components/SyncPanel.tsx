import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Segmented,
  TextInput,
} from "./ui";
import { loadSyncToken, saveSyncToken } from "~/lib/storage";
import { listTeams, syncStatus, type RemoteTeamSummary } from "~/lib/sync";
import { useAppStore } from "~/state/app-store";
import { useSyncStatus } from "~/state/auto-sync";

function relative(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr ago`;
  return new Date(timestamp).toLocaleString();
}

/**
 * Sync, as far as anyone needs to see it.
 *
 * Almost all of it happens on its own now: changes go up and come down within
 * seconds, object by object. What's left here is the handful of things a
 * person might actually want — nudge it, see which season this device is on,
 * switch to another, or start this one over from the server.
 */
export function SyncPanel() {
  const { team, chooseTeam } = useAppStore();
  const auto = useSyncStatus();

  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<RemoteTeamSummary[] | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    setToken(loadSyncToken());
    syncStatus().then((status) => {
      setAvailable(status.enabled);
      setReason(status.reason);
    });
  }, []);

  const run = useCallback(async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  const showTeams = () =>
    run(async () => {
      const found = await listTeams();
      setTeams(found);
      return found.length === 1
        ? "One season on the server."
        : `${found.length} seasons on the server.`;
    });

  /**
   * Take this season again from scratch.
   *
   * The same path a new device uses, pointed at the team already open — which
   * makes it the answer to "this device looks wrong, start it over" without
   * needing a separate restore mechanism.
   */
  const reload = () =>
    run(async () => {
      await chooseTeam(team.id);
      setConfirmReload(false);
      return "Reloaded this season from the server.";
    });

  const useSeason = (summary: RemoteTeamSummary) =>
    run(async () => {
      await chooseTeam(summary.id);
      setTeams(null);
      return `Now working in ${summary.name}.`;
    });

  const handleSaveToken = () => {
    saveSyncToken(token.trim());
    setTeams(null);
    setMessage("Sync token saved on this device.");
    syncStatus().then((status) => {
      setAvailable(status.enabled);
      setReason(status.reason);
    });
  };

  const statusLine = () => {
    if (auto.phase === "unavailable") {
      return "Server sync is unavailable — the season is saved on this device only.";
    }
    if (!auto.enabled) {
      return auto.pendingCount > 0
        ? `Auto-sync is off. ${auto.pendingCount} change${
            auto.pendingCount === 1 ? "" : "s"
          } the server doesn't have.`
        : `Auto-sync is off. Last synced ${relative(auto.lastSyncAt)}.`;
    }
    if (auto.phase === "diverged") {
      return auto.message ?? "The server had newer versions of something.";
    }
    if (auto.phase === "error") {
      return `Couldn't reach the server, retrying. Last synced ${relative(auto.lastSyncAt)}.`;
    }
    if (auto.pending || auto.phase === "syncing") {
      return `Sending ${auto.pendingCount} change${
        auto.pendingCount === 1 ? "" : "s"
      }…`;
    }
    return `Synced ${relative(auto.lastSyncAt)}. Changes go both ways on their own.`;
  };

  return (
    <Card>
      <SectionTitle
        action={
          available === true ? (
            <Button size="sm" variant="ghost" onClick={showTeams} disabled={busy}>
              Seasons
            </Button>
          ) : undefined
        }
      >
        Sync
      </SectionTitle>

      <p className="text-sm text-slate-600 dark:text-slate-300">{statusLine()}</p>

      {available === false && (
        <div className="mt-3">
          <Banner tone="warn">
            {reason ?? "The server isn't set up for syncing."}
          </Banner>
        </div>
      )}

      {available === true && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            onClick={() => auto.syncNow()}
            disabled={busy}
          >
            Sync now
          </Button>
          <Button onClick={() => setConfirmReload(true)} disabled={busy}>
            Reload from server
          </Button>
        </div>
      )}

      {confirmReload && (
        <div className="mt-3 space-y-2">
          <Banner tone="warn">
            Takes this season again from the server. Anything on this device
            that hasn&rsquo;t synced yet would be lost.
          </Banner>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="danger" onClick={reload} disabled={busy}>
              Reload
            </Button>
            <Button onClick={() => setConfirmReload(false)}>Cancel</Button>
          </div>
        </div>
      )}

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

      {teams && teams.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-bold text-slate-600 dark:text-slate-300">
            Seasons on the server
          </h3>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {teams.map((summary) => {
              const mine = summary.id === team.id;
              return (
                <li
                  key={summary.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {summary.name}
                      {summary.code && ` (${summary.code})`}
                      {mine && (
                        <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                          this device
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {summary.athletes} athlete
                      {summary.athletes === 1 ? "" : "s"} · {summary.meets} meet
                      {summary.meets === 1 ? "" : "s"} · {summary.times} time
                      {summary.times === 1 ? "" : "s"}
                    </p>
                  </div>
                  {!mine && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => useSeason(summary)}
                    >
                      Use this season
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <Field
          label="Auto-sync"
          hint="On: this device sends changes a couple of seconds after each one, and picks up other devices' changes while you're looking at it. Off: nothing moves until you tap Sync now. Set per device."
        >
          <Segmented
            value={auto.enabled ? "on" : "off"}
            onChange={(value) => auto.setEnabled(value === "on")}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Button size="sm" variant="ghost" onClick={() => setShowToken((v) => !v)}>
          {showToken ? "Hide sync token" : "Sync token"}
        </Button>
        {showToken && (
          <div className="mt-2 space-y-2">
            <Field
              label="Token"
              hint="Only needed if the server is set up to require one."
            >
              <TextInput
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the shared token"
              />
            </Field>
            <Button onClick={handleSaveToken}>Save</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

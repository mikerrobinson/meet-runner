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
import {
  listMeets,
  pullMeet,
  pullTeam,
  pushMeet,
  pushTeam,
  syncStatus,
  type RemoteMeetSummary,
} from "~/lib/sync";
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

export function SyncPanel() {
  const {
    team,
    meets,
    deletedMeets,
    getMeet,
    deleteMeet,
    replaceTeam,
    replaceMeet,
    markTeamSynced,
    markMeetSynced,
  } = useAppStore();
  const auto = useSyncStatus();

  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteMeetSummary[] | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    setToken(loadSyncToken());
    syncStatus().then((status) => {
      setAvailable(status.enabled);
      setReason(status.reason);
    });
  }, []);

  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleList = () =>
    run(async () => {
      const found = await listMeets();
      setRemote(found);
      return found.length
        ? `Found ${found.length} meet${found.length === 1 ? "" : "s"} on the server.`
        : "No meets on the server yet.";
    });

  const handlePushAll = () =>
    run(async () => {
      let pushed = 0;
      // Roster first: a meet's swimmer ids mean nothing to another device
      // until the roster they point into has landed.
      if (team.syncedAt !== team.updatedAt) {
        const sentAt = team.updatedAt;
        await pushTeam(team);
        markTeamSynced(sentAt);
        pushed += 1;
      }
      for (const meet of [...meets, ...deletedMeets]) {
        if (meet.syncedAt === meet.updatedAt) continue;
        const sentAt = meet.updatedAt;
        const { applied } = await pushMeet(meet);
        // A refused push means the server is ahead; saying "pushed" would be
        // a lie, and marking it synced would bury the divergence.
        if (!applied) {
          throw new Error(
            `The server has a newer copy of ${meet.name}. Nothing was overwritten — restore from the server first.`,
          );
        }
        markMeetSynced(meet.id, sentAt);
        pushed += 1;
      }
      // Clears any backoff the background sync had settled into.
      auto.syncNow();
      return pushed === 0
        ? "Everything was already up to date."
        : `Pushed ${pushed} document${pushed === 1 ? "" : "s"}.`;
    });

  /** Pull the roster and every meet the server has, roster first. */
  const doRestore = () =>
    run(async () => {
      const remoteTeam = await pullTeam();
      if (!remoteTeam) throw new Error("The server has no team yet.");
      replaceTeam({ ...remoteTeam, syncedAt: remoteTeam.updatedAt });

      const summaries = await listMeets();
      let restored = 0;
      let dropped = 0;
      for (const summary of summaries) {
        // A tombstone is news too: this device may still be holding the meet
        // that another one deleted.
        if (summary.deletedAt) {
          if (getMeet(summary.id)) {
            deleteMeet(summary.id);
            dropped += 1;
          }
          continue;
        }
        const meet = await pullMeet(summary.id);
        if (!meet) continue;
        replaceMeet({ ...meet, syncedAt: meet.updatedAt });
        restored += 1;
      }
      setConfirmRestore(false);
      const removals =
        dropped > 0 ? `, and removed ${dropped} deleted elsewhere` : "";
      return `Restored ${remoteTeam.swimmers.length} swimmers and ${restored} meet${
        restored === 1 ? "" : "s"
      }${removals}.`;
    });

  const handleSaveToken = () => {
    saveSyncToken(token.trim());
    setRemote(null);
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
        ? `Auto-sync is off. ${auto.pendingCount} document${
            auto.pendingCount === 1 ? "" : "s"
          } the server doesn't have.`
        : `Auto-sync is off. Last pushed ${relative(auto.lastSyncAt)}.`;
    }
    if (auto.phase === "diverged") {
      return auto.message ?? "The server has a newer copy than this device.";
    }
    if (auto.phase === "error") {
      return `Couldn't reach the server, retrying. Last synced ${relative(auto.lastSyncAt)}.`;
    }
    if (auto.pending || auto.phase === "syncing") {
      return `Saving ${auto.pendingCount} document${
        auto.pendingCount === 1 ? "" : "s"
      } to the server…`;
    }
    return `Saved to the server ${relative(auto.lastSyncAt)}. Changes sync on their own.`;
  };

  return (
    <Card>
      <SectionTitle
        action={
          available === true ? (
            <Button size="sm" variant="ghost" onClick={handleList} disabled={busy}>
              Browse
            </Button>
          ) : undefined
        }
      >
        Sync
      </SectionTitle>

      {available === false && (
        <Banner tone="warn">
          Server sync is unavailable{reason ? `: ${reason}` : ""}. The season is
          still saved on this device and everything works offline.
        </Banner>
      )}

      <p className="text-sm text-slate-600 dark:text-slate-300">{statusLine()}</p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="primary" onClick={handlePushAll} disabled={busy}>
          Push now
        </Button>
        <Button onClick={() => setConfirmRestore(true)} disabled={busy}>
          Restore from server
        </Button>
      </div>

      {confirmRestore && (
        <div className="mt-3 space-y-2">
          <Banner tone="warn">
            This replaces the roster and every meet on this device with the
            server's copy. Anything here that hasn't been pushed would be lost.
          </Banner>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="danger" onClick={doRestore} disabled={busy}>
              Replace local
            </Button>
            <Button onClick={() => setConfirmRestore(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {auto.phase !== "unavailable" && (
        <div className="mt-4">
          <Field
            label="Auto-sync"
            hint="On: this device backs the season up a couple of seconds after each change. Off: nothing leaves the device until you tap Push now. Set per device."
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
      )}

      {remote && remote.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-bold text-slate-600 dark:text-slate-300">
            On the server
          </h3>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {remote
              .filter((summary) => !summary.deletedAt)
              .map((summary) => {
                const here = meets.some((m) => m.id === summary.id);
                return (
                  <li
                    key={summary.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {summary.name}
                        {here && (
                          <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                            on this device
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">
                        {summary.date} · saved {relative(summary.updatedAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={here ? "secondary" : "primary"}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const meet = await pullMeet(summary.id);
                          if (!meet) throw new Error("That meet is gone.");
                          replaceMeet({ ...meet, syncedAt: meet.updatedAt });
                          return `Pulled "${meet.name}".`;
                        })
                      }
                    >
                      {here ? "Reload" : "Pull"}
                    </Button>
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowToken((v) => !v)}
        >
          {showToken ? "Hide sync token" : "Sync token"}
        </Button>
      </div>

      {showToken && (
        <div className="mt-2 flex gap-2">
          <TextInput
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Sync token (if your worker requires one)"
            autoComplete="off"
          />
          <Button onClick={handleSaveToken}>Save</Button>
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
    </Card>
  );
}

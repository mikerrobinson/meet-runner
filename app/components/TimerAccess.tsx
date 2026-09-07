import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { QrCode } from "./QrCode";
import { request } from "~/lib/http";
import { useAppStore } from "~/state/app-store";
import type { MeetDoc } from "~/types/meet";

/**
 * The coach's end of the timing QR code.
 *
 * Print it, tape it to the timing table, and anyone who scans it is timing —
 * no account, no app to install, nothing to type. That is the point, and it's
 * also the whole of the security model, so this screen says so plainly rather
 * than burying it.
 *
 * The link is shown once. Making another retires the old one, which is also
 * how you revoke a sheet that's gone walkabout.
 */
export function TimerAccess({ meet }: { meet: MeetDoc }) {
  // Whose authority the grant is issued under. A meet has several teams and
  // belongs to none of them, so the one that matters is the team this coach
  // is actually a member of — the server checks exactly that.
  const { team } = useAppStore();
  const [live, setLive] = useState<{ expiresAt: number } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const check = useCallback(() => {
    request<{ grant: { expiresAt: number } | null }>(
      `/api/timer/grant?meetId=${encodeURIComponent(meet.id)}`,
    )
      .then((body) => setLive(body.grant))
      .catch(() => setLive(null));
  }, [meet.id]);

  useEffect(check, [check]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const body = await request<{ url: string; expiresAt: number }>(
        "/api/timer/grant",
        {
          method: "POST",
          body: JSON.stringify({
            meetId: meet.id,
            teamId: team.id,
            date: meet.date,
          }),
        },
      );
      setUrl(body.url);
      setLive({ expiresAt: body.expiresAt });
      setCopied(false);
    });

  const revoke = () =>
    run(async () => {
      await request("/api/timer/grant", {
        method: "DELETE",
        body: JSON.stringify({ meetId: meet.id, teamId: team.id }),
      });
      setUrl(null);
      setLive(null);
    });

  return (
    <Card className="print:border-0">
      <SectionTitle>Timers</SectionTitle>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {url ? (
        <div className="space-y-3">
          <div className="flex justify-center rounded-2xl bg-white p-4">
            <QrCode value={url} size={260} />
          </div>
          <p className="break-all text-center font-mono text-xs text-slate-500">
            {url}
          </p>
          <Banner tone="warn">
            Anyone who scans this can record times for this meet, so treat the
            printout like a key. It stops working on{" "}
            {new Date(live?.expiresAt ?? Date.now()).toLocaleDateString()}.
          </Banner>
          <div className="grid grid-cols-2 gap-2 print:hidden">
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button onClick={() => window.print()}>Print</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {live
              ? "A timing code is already out for this meet. Making a new one stops the old one working."
              : "Print a code for the timing table. Timers scan it, pick their lane, and start — no account, nothing to install."}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              {live ? "Replace the code" : "Make a timing code"}
            </Button>
            {live && (
              <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
                Turn it off
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

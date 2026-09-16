import { useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { QrCode } from "./QrCode";

interface GrantResult {
  ok?: boolean;
  error?: string;
  /** The scannable link. Handed over exactly once, by the action that mints it. */
  url?: string;
  expiresAt?: number;
}

/**
 * The coach's end of the timing QR code.
 *
 * Print it, tape it to the timing table, and anyone who scans it is timing —
 * no account, no app to install, nothing to type. That is the point, and it's
 * also the whole of the security model, so this screen says so plainly rather
 * than burying it.
 *
 * The link is shown once. Making another retires the old one, which is also
 * how you revoke a sheet that's gone walkabout — and it is shown from the
 * action's own answer rather than held anywhere, which is what keeps "once"
 * true: navigate away and the only copy left is the one you printed.
 *
 * Whether a code is currently live arrives with the page; only minting and
 * revoking are submissions.
 */
export function TimerAccess({
  grant,
}: {
  grant: { expiresAt: number } | null;
}) {
  const fetcher = useFetcher<GrantResult>();
  const [copied, setCopied] = useState(false);

  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.error ?? null;

  // The freshly minted link, if one was made on this visit. `grant` is the
  // standing fact — that a code exists and when it dies — and survives the
  // revalidation that follows; the URL deliberately does not.
  const url = fetcher.data?.url ?? null;
  const expiresAt = fetcher.data?.expiresAt ?? grant?.expiresAt;

  const submit = (intent: string) => {
    setCopied(false);
    fetcher.submit({ intent }, { method: "post" });
  };

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
            {new Date(expiresAt ?? Date.now()).toLocaleDateString()}.
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
            {grant
              ? "A timing code is already out for this meet. Making a new one stops the old one working."
              : "Print a code for the timing table. Timers scan it, pick their lane, and start — no account, nothing to install."}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => submit("grant-create")}
            >
              {grant ? "Replace the code" : "Make a timing code"}
            </Button>
            {grant && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => submit("grant-revoke")}
              >
                Turn it off
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/sign-in";
import { Banner, Button, Card, Field, TextInput } from "~/components/ui";
import {
  inspectInvite,
  requestCode,
  verifyCode,
  type CodeSent,
  type InviteInfo,
} from "~/lib/auth";
import { CODE_LENGTH, ROLE_LABELS, normalizeCode } from "~/lib/identity";
import { APP_HOME } from "./home";
import { useSession } from "~/state/session";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in · Meet Runner" }];
}

/**
 * Signing in, which is also signing up.
 *
 * Type a contact, read the code that arrives, and you're in — a contact nobody
 * has used before becomes an account on the way through. There's no password
 * to choose or forget, and nothing else to fill in: the only fact the app
 * needs about a coach is somewhere it can reach them.
 *
 * The email also carries a link back here with the contact and code already
 * in it, which is why this screen can arrive part-way through and finish on
 * its own.
 */
export default function SignIn() {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const invite = params.get("invite");
  const [step, setStep] = useState<"contact" | "code">("contact");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [invited, setInvited] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Leaving this screen, whether you just signed in or were signed in all
   * along.
   *
   * One effect decides where to go, rather than the sign-in path navigating
   * for itself: adopting a session flips `status` to "in", so a separate
   * "you're already signed in, go home" redirect would race the deliberate
   * one and win — which is exactly what it used to do, landing a coach with
   * no team on a blank home screen instead of on the team picker.
   *
   * Someone who arrived holding an invitation stays put until they've signed
   * in, since that's the only way to redeem it.
   */
  const signedInHere = useRef(false);
  const carried = useRef<string | null>(null);
  useEffect(() => {
    if (session.status !== "in") return;
    if (invite && !signedInHere.current) return;
    navigate(session.openTeamId ? APP_HOME : "/join", {
      replace: true,
      state: carried.current ? { notice: carried.current } : undefined,
    });
  }, [session.status, session.openTeamId, invite, navigate]);

  useEffect(() => {
    if (!invite) return;
    inspectInvite(invite)
      .then(setInvited)
      .catch((err) =>
        setInviteError(err instanceof Error ? err.message : "That invitation isn't valid."),
      );
  }, [invite]);

  const submitCode = useCallback(
    async (forContact: string, submitted: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await verifyCode(forContact, submitted, invite);
        signedInHere.current = true;
        // Signed in, but the link was spent. Carried along so it can be said
        // wherever they land, rather than dropping them there unexplained.
        carried.current = next.inviteError ?? null;
        session.adopt(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
        setCode("");
      } finally {
        setBusy(false);
      }
    },
    [invite, session],
  );

  // The emailed link lands here with both halves already filled in. Done once,
  // guarded, because a re-render must not spend the code a second time.
  const autoTried = useRef(false);
  useEffect(() => {
    const linkContact = params.get("contact");
    const linkCode = params.get("code");
    if (!linkContact || !linkCode || autoTried.current) return;
    autoTried.current = true;
    setContact(linkContact);
    setCode(normalizeCode(linkCode));
    setStep("code");
    void submitCode(linkContact, linkCode);
  }, [params, submitCode]);

  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestCode(contact);
      setSent(result);
      setStep("code");
      if (result.code) setCode(result.code);
      if (!result.sent) {
        setNotice(
          `${result.detail ?? "Nothing was sent."} The code is in the server log.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send a code.");
    } finally {
      setBusy(false);
    }
  };

  const ready = normalizeCode(code).length === CODE_LENGTH;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Meet Runner</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {invited
            ? `Join ${invited.name} as ${ROLE_LABELS[invited.role].toLowerCase()}.`
            : "Sign in with your email or mobile number."}
        </p>
      </div>

      {inviteError && (
        <div className="mb-4">
          <Banner tone="warn">
            {inviteError} You can still sign in — you&rsquo;ll just need a coach
            to let you onto the team.
          </Banner>
        </div>
      )}

      <Card>
        {step === "contact" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Field
              label="Email or mobile"
              hint="We'll send a six-digit code. No password to remember."
            >
              <TextInput
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                // A single field for both, so nobody has to pick a kind before
                // typing the thing that already says which kind it is.
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="you@school.org or (480) 555-0134"
                autoFocus
              />
            </Field>
            <div className="mt-4">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                full
                disabled={busy || !contact.trim()}
              >
                {busy ? "Sending…" : "Send code"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode(sent?.contact ?? contact, code);
            }}
          >
            <Field
              label="Code"
              hint={
                sent
                  ? `Sent to ${sent.masked}. It's good for ten minutes.`
                  : "Enter the code you were sent."
              }
            >
              <TextInput
                value={code}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                // `one-time-code` is what lets iOS and Android offer the code
                // from the notification instead of making anyone retype it.
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="text-center text-2xl tracking-[0.4em]"
                autoFocus
              />
            </Field>
            <div className="mt-4">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                full
                disabled={busy || !ready}
              >
                {busy ? "Checking…" : "Sign in"}
              </Button>
            </div>
            <div className="mt-3 flex justify-between">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setStep("contact");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
              >
                Use a different one
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send()}>
                Send again
              </Button>
            </div>
          </form>
        )}

        {error && (
          <div className="mt-3">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        {notice && (
          <div className="mt-3">
            <Banner tone="warn">{notice}</Banner>
          </div>
        )}
      </Card>

      <p className="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
        Timing a lane? You don&rsquo;t need an account — use the link or QR code
        your coach gives you on the day.
      </p>
    </main>
  );
}

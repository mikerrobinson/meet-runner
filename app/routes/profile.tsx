import { useCallback, useEffect, useState } from "react";
import type { Route } from "./+types/profile";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { request } from "~/lib/http";
import { useSession } from "~/state/session";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Profile · Meet Runner" }];
}

interface Identity {
  contact: string;
  kind: string;
}

interface Profile {
  name: string | null;
  identities: Identity[];
}

/**
 * Your name, and the ways you can sign in.
 *
 * The contacts are the interesting half. A person isn't one email address — a
 * coach has a school address and a mobile, and either should open the same
 * account rather than minting a second one that owns none of their teams.
 */
export default function ProfileScreen() {
  const session = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Adding a contact is two steps: send a code, then prove it.
  const [adding, setAdding] = useState("");
  const [code, setCode] = useState("");
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const load = useCallback(() => {
    request<Profile>("/api/profile")
      .then((body) => {
        setProfile(body);
        setName(body.name ?? "");
      })
      .catch(() => setProfile(null));
  }, []);

  useEffect(load, [load]);

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

  if (session.status === "out") {
    return (
      <Card>
        <EmptyState title="Not signed in">
          Sign in to see your profile.
        </EmptyState>
      </Card>
    );
  }

  if (!profile) {
    return (
      <Card>
        <p className="text-sm text-slate-500">Loading…</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Banner tone="error">{error}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}

      <Card>
        <SectionTitle>Your name</SectionTitle>
        <Field
          label="Name"
          hint="Shown to coaches on your team, and next to a meet you run."
        >
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mike Robinson"
            autoCapitalize="words"
          />
        </Field>
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={busy || name === (profile.name ?? "")}
            onClick={() =>
              void run(async () => {
                await request("/api/profile", {
                  method: "PATCH",
                  body: JSON.stringify({ name }),
                });
                setNote("Name saved.");
                load();
                // The header shows it, so it has to hear about the change.
                void session.refresh();
              })
            }
          >
            Save
          </Button>
        </div>
      </Card>

      <Card>
        <SectionTitle>Ways to sign in</SectionTitle>
        <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          Any of these opens this account. There&rsquo;s no password — a code
          goes to whichever one you use.
        </p>

        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {profile.identities.map((identity) => (
            <li
              key={identity.contact}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {identity.contact}
                </span>
                <span className="block text-xs text-slate-500">
                  {identity.kind === "email" ? "Email" : "Mobile"}
                </span>
              </span>
              {profile.identities.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("/api/profile", {
                        method: "DELETE",
                        body: JSON.stringify({ contact: identity.contact }),
                      });
                      load();
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          {awaiting ? (
            <>
              <Field
                label="Code"
                hint={`Sent to ${awaiting}. Enter it to add this contact.`}
              >
                <TextInput
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  disabled={busy || !code.trim()}
                  onClick={() =>
                    void run(async () => {
                      await request("/api/profile", {
                        method: "POST",
                        body: JSON.stringify({ contact: awaiting, code }),
                      });
                      setAwaiting(null);
                      setAdding("");
                      setCode("");
                      setNote("Contact added.");
                      load();
                    })
                  }
                >
                  Add it
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setAwaiting(null);
                    setCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field label="Add an email or mobile">
                <TextInput
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  placeholder="you@example.com"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </Field>
              <Button
                disabled={busy || !adding.trim()}
                onClick={() =>
                  void run(async () => {
                    const body = await request<{
                      masked?: string;
                      code?: string;
                      detail?: string;
                    }>("/api/profile", {
                      method: "POST",
                      body: JSON.stringify({ contact: adding }),
                    });
                    setAwaiting(adding.trim());
                    setNote(
                      body.code
                        ? `No mail provider configured here — your code is ${body.code}.`
                        : `Code sent to ${body.masked ?? adding}.`,
                    );
                  })
                }
              >
                Send a code
              </Button>
            </>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle>Signing out</SectionTitle>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Signing out leaves this device&rsquo;s season where it is — it keeps
          working offline. It only stops the server knowing whose it is.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => void session.signOut()}>Sign out</Button>
          <Button variant="danger" onClick={() => void session.signOut(true)}>
            Sign out everywhere
          </Button>
        </div>
      </Card>
    </div>
  );
}

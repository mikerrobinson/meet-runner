import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/teams";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Sheet,
  TextInput,
} from "~/components/ui";
import { listPublicTeams } from "~/lib/public.server";
import { useSession } from "~/state/session";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { claimNewTeam } from "~/lib/auth.server";
import { generateId } from "~/lib/id";
import { normalizeTeamCode } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Teams · Meet Runner" }];
}

/**
 * Every team this server knows about.
 *
 * Read on the server rather than from the store, because the store only ever
 * holds *your* team — and the whole point of this page is the ones that
 * aren't yours. No account needed: a team's name and size are on every heat
 * sheet already.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { teams: [], offline: true };
  try {
    return { teams: await listPublicTeams(env.DB), offline: false };
  } catch {
    return { teams: [], offline: true };
  }
}

/**
 * Starting one.
 *
 * The same shape as creating a meet, and for the same reason: the list of
 * teams is where you are when you notice yours isn't on it. Whoever fills the
 * form is its head coach from that moment — a team with no coach can't admit
 * anybody, so the alternative is making one and then asking to be let into it.
 *
 * A name that's already here is answered with the team that has it rather than
 * a second copy. Two "Horizon"s is the failure this guards against, and it's
 * the same rule `POST /api/teams` follows when a meet is being set up against
 * an opponent.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  if (!user) throw new Response("Sign in to start a team", { status: 403 });

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 80);
  if (!name) return { error: "A team needs a name." };

  const existing = await listPublicTeams(db);
  const clash = existing.find(
    (team) => team.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return {
      error: clash.claimed
        ? `${clash.name} is already here. Open it and ask to join.`
        : `${clash.name} is already here, and nobody has claimed it. Open it and claim it.`,
      teamId: clash.id,
    };
  }

  // The id is minted here and the team, its first season and the membership
  // are written together — see `claimNewTeam`, which exists so a team can
  // never exist with nobody holding it.
  const result = await claimNewTeam(db, user.id, generateId(), {
    name,
    code: String(form.get("code") ?? "") || undefined,
  });
  if (!result.ok) return { error: result.error };

  return redirect(`/teams/${result.membership.teamId}`);
}

export default function Teams({ loaderData, actionData }: Route.ComponentProps) {
  const { teams, offline } = loaderData;
  // Which of these are yours comes from your memberships — the page is a
  // directory of everyone's teams, and "yours" is just a heading on it.
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const mineIds = new Set(
    session.memberships.filter((m) => m.status === "active").map((m) => m.teamId),
  );

  const ours = teams.filter((t) => mineIds.has(t.id));
  const others = teams.filter((t) => !mineIds.has(t.id));

  return (
    <div className="space-y-4">

      {/* Yours, once you're signed in — empty included, because that's where
          the button to start one lives and a coach with no team yet is
          exactly who needs it. */}
      {session.status === "in" && (
        <Card>
          <SectionTitle
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAdding(true)}
              >
                + Team
              </Button>
            }
          >
            {ours.length === 1 ? "Your team" : "Your teams"}
          </SectionTitle>

          {ours.length === 0 ? (
            <EmptyState title="You're not on a team yet">
              Start one and you&rsquo;re its head coach. If yours is in the list
              below, open it and ask to join instead.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {ours.map((team) => (
                <TeamRow key={team.id} team={team} />
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <SectionTitle>
          {ours.length > 0 ? `Other teams (${others.length})` : `Teams (${teams.length})`}
        </SectionTitle>

        {others.length === 0 ? (
          <EmptyState title={offline ? "Can't reach the server" : "No other teams yet"}>
            {
              offline
                ? "This list lives on the server. Your own team and meets keep working without it."
                : "A team appears here once someone races it — including opponents typed in while setting up a meet."
            }
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {others.map((team) => (
              <TeamRow key={team.id} team={team} />
            ))}
          </ul>
        )}
      </Card>

      {adding && (
        <NewTeamSheet
          error={actionData?.error}
          teamId={actionData?.teamId}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * Setting one up.
 *
 * A plain form posting to this route's action, exactly as a new meet is — no
 * state beyond whether the sheet is open, because nothing here needs deciding
 * before it's submitted.
 */
function NewTeamSheet({
  error,
  teamId,
  onClose,
}: {
  error?: string;
  teamId?: string;
  onClose: () => void;
}) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [name, setName] = useState("");

  return (
    <Sheet open title="New team" onClose={onClose}>
      <Form method="post" className="space-y-3">
        {error && (
          <Banner tone="error">
            {error}
            {teamId && (
              <>
                {" "}
                <Link to={`/teams/${teamId}`} className="font-semibold underline">
                  Open it
                </Link>
              </>
            )}
          </Banner>
        )}

        <Field label="Name">
          <TextInput
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cactus Shadows High School"
            autoCapitalize="words"
            autoFocus
          />
        </Field>

        <Field
          label="Code"
          hint="What it's called on a heat sheet. Left blank, it's made from the name."
        >
          <TextInput
            name="code"
            placeholder={normalizeTeamCode(name) || "CACTUS"}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          You&rsquo;ll be its head coach. Add the roster, its seasons and the
          other coaches on the team&rsquo;s own page.
        </p>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          full
          disabled={saving || !name.trim()}
        >
          {saving ? "Creating…" : "Create team"}
        </Button>
      </Form>
    </Sheet>
  );
}

function TeamRow({
  team,
}: {
  team: {
    id: string;
    name: string;
    code: string;
    claimed: boolean;
    athletes: number;
    meets: number;
  };
}) {
  return (
    <li>
      <Link
        to={`/teams/${team.id}`}
        className="flex items-center justify-between gap-3 py-3"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{team.name}</span>
            {team.code && (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {team.code}
              </span>
            )}
            {/* Worth saying plainly: an unclaimed team is one anybody may
                still claim, which is how a coach takes over the placeholder
                an opponent created for them. */}
            {!team.claimed && (
              <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                unclaimed
              </span>
            )}
          </span>
          <span className="block text-xs text-slate-500">
            {team.athletes} athlete{team.athletes === 1 ? "" : "s"} · {team.meets}{" "}
            meet{team.meets === 1 ? "" : "s"}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </Link>
    </li>
  );
}

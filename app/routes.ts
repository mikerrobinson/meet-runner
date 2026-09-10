import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  // Signing in and finding a team sit outside the shell: there's no team to
  // put in its header and nowhere for its tabs to go.
  route("sign-in", "routes/sign-in.tsx"),
  route("join", "routes/join.tsx"),

  // The timer's whole world: a scanned link, and the stopwatch it opens.
  // Outside the shell — no team header, no tab bar, nothing to wander into.
  route("t/:token", "routes/timer-claim.tsx"),
  route("timer", "routes/timer.tsx"),

  layout("routes/shell.tsx", [
    index("routes/home.tsx"),

    // The coach's own roster, editable, behind a membership.
    route("team", "routes/team.tsx"),

    // Browsing: every team and everyone, read from the server rather than the
    // store — the store only ever holds your team, and these are the pages
    // that exist to show the ones that aren't yours.
    route("teams", "routes/teams.tsx"),
    route("teams/:teamId", "routes/team-detail.tsx"),
    route("athletes", "routes/athletes.tsx"),
    route("athletes/:athleteId", "routes/athlete-detail.tsx"),

    // Somebody's own page: their teams, their meets, their times.
    route("users/:userId", "routes/user-detail.tsx"),
    route("profile", "routes/profile.tsx"),

    route("meets", "routes/meets.tsx"),
    // Everything under a meet id runs against that one meet.
    // A meet's sections. Read-only for everyone; the editing appears for
    // whoever the server says may edit. Setup used to be its own screen —
    // it's now the editable half of the meet's own page, because "set it up"
    // and "look at it" were never different places.
    route("meets/:meetId", "routes/meet-layout.tsx", [
      index("routes/meet-info.tsx"),
      route("entries", "routes/entries.tsx"),
      route("results", "routes/results.tsx"),
      route("run", "routes/run.tsx"),
    ]),

    route("settings", "routes/settings.tsx"),
  ]),

  // Resource routes for syncing to D1.
  route("api/sync-status", "routes/api.sync-status.ts"),
  route("api/sync", "routes/api.sync.ts"),

  // Reading. Open, because a meet is a public event — the heat sheet is handed
  // out at the door. Sync is for working a deck; this is for everyone else.
  route("api/teams", "routes/api.teams.ts"),
  route("api/teams/:teamId", "routes/api.public.team.ts"),
  route("api/meets", "routes/api.public.meets.ts"),
  route("api/meets/:meetId", "routes/api.public.meet.ts"),
  route("api/meets/:meetId/admins", "routes/api.meet.admins.ts"),
  route("api/meets/:meetId/me", "routes/api.meet.me.ts"),
  route("api/athletes", "routes/api.public.athletes.ts"),
  route("api/athletes/:athleteId", "routes/api.public.athlete.ts"),
  route("api/users/:userId", "routes/api.public.user.ts"),

  // Accounts and membership.
  route("api/auth/start", "routes/api.auth.start.ts"),
  route("api/auth/verify", "routes/api.auth.verify.ts"),
  route("api/auth/session", "routes/api.auth.session.ts"),
  route("api/profile", "routes/api.profile.ts"),
  route("api/memberships", "routes/api.memberships.ts"),
  route("api/members", "routes/api.members.ts"),
  route("api/athletes/:athleteId/link", "routes/api.athlete.link.ts"),
  route("api/invites", "routes/api.invites.ts"),

  // Timers. A meet-scoped grant, not an account.
  route("api/timer/grant", "routes/api.timer.grant.ts"),
  route("api/timer/meet", "routes/api.timer.meet.ts"),
  route("api/timer/watch", "routes/api.timer.watch.ts"),
] satisfies RouteConfig;

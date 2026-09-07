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

    route("team", "routes/team.tsx"),
    route("athletes/:athleteId", "routes/athlete-detail.tsx"),

    route("meets", "routes/meets.tsx"),
    // Everything under a meet id runs against that one meet.
    route("meets/:meetId", "routes/meet-layout.tsx", [
      index("routes/meet-overview.tsx"),
      route("setup", "routes/setup.tsx"),
      route("registration", "routes/registration.tsx"),
      route("run", "routes/run.tsx"),
      route("results", "routes/results.tsx"),
    ]),

    route("settings", "routes/settings.tsx"),
  ]),

  // Resource routes for syncing to D1.
  route("api/sync-status", "routes/api.sync-status.ts"),
  route("api/sync", "routes/api.sync.ts"),
  route("api/teams", "routes/api.teams.ts"),

  // Accounts and membership.
  route("api/auth/start", "routes/api.auth.start.ts"),
  route("api/auth/verify", "routes/api.auth.verify.ts"),
  route("api/auth/session", "routes/api.auth.session.ts"),
  route("api/memberships", "routes/api.memberships.ts"),
  route("api/invites", "routes/api.invites.ts"),

  // Timers. A meet-scoped grant, not an account.
  route("api/timer/grant", "routes/api.timer.grant.ts"),
  route("api/timer/meet", "routes/api.timer.meet.ts"),
  route("api/timer/watch", "routes/api.timer.watch.ts"),
] satisfies RouteConfig;

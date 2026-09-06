import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    index("routes/home.tsx"),

    route("team", "routes/team.tsx"),
    route("team/:swimmerId", "routes/swimmer-detail.tsx"),

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
] satisfies RouteConfig;

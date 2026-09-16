import {
  type RouteConfig,
  index,
  route,
  layout,
} from "@react-router/dev/routes";

export default [
  // Signing in and finding a team sit outside the shell: there's no team to
  // put in its header and nowhere for its tabs to go.
  route("sign-in", "routes/sign-in.tsx"),
  route("join", "routes/join.tsx"),

  // Ending a session, which is the one account move reachable from every page
  // rather than from a screen of its own.
  route("session", "routes/session.ts"),

  /**
   * The timer's whole world: a scanned link, a lane, and the stopwatch.
   *
   * Outside the shell — no team header, no tab bar, nothing to wander into.
   *
   * Addressed the same way the endpoint behind them is, because where a timer
   * is standing is not device state: it is which page they are on. Changing
   * heats is a link, going back a heat is the back button, and a phone that
   * reloads comes back exactly where it was without having remembered
   * anything. It is also what a volunteer can be read down the pool — "you're
   * on event seven, heat one, lane three" — when something has gone wrong.
   */
  route("t/:token", "routes/timer-claim.tsx"),
  route("meets/:meetId/timers/:timerId", "routes/timer-lanes.tsx"),
  route("meets/:meetId/timers/:timerId/:event/:heat/:lane", "routes/timer.tsx"),

  layout("routes/shell.tsx", [
    index("routes/home.tsx"),

    // Every team and everyone. One page per team, whether you coach there or
    // are following a link to look — the editing appears for whoever the
    // server says may edit, so there is no second copy of a roster to drift.
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

  ]),

  // Lists of people, and searching for one. The screens that show a team or a
  // meet load it from their own loader; these are what the cards on those
  // screens ask for as somebody types.
  route("api/teams", "routes/api.teams.ts"),
  route("api/users", "routes/api.users.ts"),

  // What the deck writes. Small, single-row endpoints: the outbox posts one of
  // these per thing somebody did, so two people working at once never touch
  // the same row.
  route("api/meets/:meetId/entries", "routes/api.meet.entries.ts"),
  route("api/meets/:meetId/seeds", "routes/api.meet.seeds.ts"),
  route("api/meets/:meetId/watches", "routes/api.meet.watches.ts"),
  route("api/meets/:meetId/results", "routes/api.meet.results.ts"),

  // Timers. A meet-scoped grant, not an account.
  // One lane, one timer. The phone posts here and the browser brings whatever
  // that lane still owes along with it, as cookies scoped to this very path.
  route(
    "api/meets/:meetId/timers/:timerId/:event/:heat/:lane",
    "routes/api.timer.lane.ts",
  ),

  route("api/timer/meet", "routes/api.timer.meet.ts"),
] satisfies RouteConfig;

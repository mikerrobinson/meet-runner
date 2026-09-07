import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { currentSeason, rosterFor } from "~/lib/roster";
import { useAppStore } from "~/state/app-store";
import { syncLabel, useSyncStatus } from "~/state/auto-sync";
import { useSession } from "~/state/session";
import { useViewPrefs } from "~/state/view-prefs";
import { LANE_LAYOUTS, meetSubtitle, type LaneLayout } from "~/types/meet";

const CHIP_TONES: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  busy: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  muted: "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

interface Tab {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

/** Where you are when you're not inside a meet. */
const TOP_TABS: Tab[] = [
  { to: "/team", label: "Team", icon: "👥" },
  { to: "/meets", label: "Meets", icon: "🏊" },
  // Everyone else's teams and swimmers, read from the server. Separate from
  // "Team", which is the one roster this device can actually edit.
  { to: "/teams", label: "Browse", icon: "🔎" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

/**
 * Inside a meet the bar becomes that meet's modes, with a way back out. Run is
 * the screen used under pressure, so it stays on the bottom bar within thumb
 * reach rather than moving to a tab across the top.
 */
function meetTabs(meetId: string): Tab[] {
  const base = `/meets/${meetId}`;
  return [
    { to: "/meets", label: "Meets", icon: "‹" },
    { to: `${base}/setup`, label: "Setup", icon: "⚙️" },
    { to: `${base}/registration`, label: "Register", icon: "📋" },
    { to: `${base}/run`, label: "Run", icon: "⏱️" },
    { to: `${base}/results`, label: "Results", icon: "🏅" },
  ];
}

/**
 * The header's view switcher, centred between the title and the sync chip.
 *
 * One control for every screen that has a way of looking at itself: the
 * registration grid filters by gender, the stopwatch picks its button layout.
 * Living in the header costs no vertical space on the screens that want every
 * pixel, and keeps the same control in the same place everywhere.
 *
 * An option is a `Link` when the state belongs in the URL and a button when it
 * belongs to the device; either way they look and behave identically.
 */
interface ToggleOption {
  value: string;
  label: string;
  title?: string;
  active: boolean;
  to?: string;
  onSelect?: () => void;
}

function HeaderToggles({
  label,
  options,
  disabled,
}: {
  label: string;
  options: ToggleOption[];
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
    >
      {options.map((option, index) => {
        const className = `flex h-8 touch-manipulation items-center justify-center px-3 text-xs font-bold transition-colors ${
          index > 0 ? "border-l border-slate-300 dark:border-slate-700" : ""
        } ${
          option.active
            ? "bg-blue-600 text-white"
            : "text-slate-600 dark:text-slate-300"
        } ${disabled ? "opacity-50" : ""}`;

        return option.to !== undefined && !disabled ? (
          <Link
            key={option.value}
            to={option.to}
            replace
            title={option.title ?? option.label}
            aria-label={option.title ?? option.label}
            aria-current={option.active ? "true" : undefined}
            className={className}
          >
            {option.label}
          </Link>
        ) : (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={option.onSelect}
            title={option.title ?? option.label}
            aria-label={option.title ?? option.label}
            aria-pressed={option.active}
            className={className}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Girls / Boys for the registration grid. Rides on a search param so the grid
 * needn't share state with the chrome.
 *
 * There's no "All" button: showing everyone is the default, and tapping the
 * active filter is the way back to it.
 */
function genderOptions(pathname: string, current: string): ToggleOption[] {
  return [
    { value: "f", label: "Girls" },
    { value: "m", label: "Boys" },
  ].map((option) => {
    const active = current === option.value;
    return {
      ...option,
      active,
      title: active
        ? `${option.label} only — tap to show everyone`
        : `${option.label} only`,
      // Tapping the active one clears the filter; tapping the other swaps to
      // it. Either way only one can be on.
      to: active ? pathname : `${pathname}?g=${option.value}`,
    };
  });
}

/**
 * How the stopwatch arranges its lane buttons. A single column in pool order
 * suits watching from the side; the grid suits standing at the end. It's a
 * device preference, so it carries to the next meet.
 */
function layoutOptions(
  laneCount: number,
  current: LaneLayout,
  choose: (layout: LaneLayout) => void,
): ToggleOption[] {
  const labels: Record<LaneLayout, string> = {
    grid: "Grid",
    "list-asc": `1→${laneCount}`,
    "list-desc": `${laneCount}→1`,
  };

  return LANE_LAYOUTS.map((layout) => ({
    value: layout,
    label: labels[layout],
    title:
      layout === "grid"
        ? "Lane buttons in a grid"
        : `Lane buttons in one column, ${labels[layout]}`,
    active: current === layout,
    onSelect: () => choose(layout),
  }));
}

/**
 * Make sure this device is holding the right season, and send it somewhere
 * useful when it isn't.
 *
 * The rule is that local data wins. A device that already has the season keeps
 * working with no network and no session — which is the state a phone is in
 * when the pool wifi drops mid-meet, and no time to be asked to sign in. Only
 * a device holding nothing has to be told who it belongs to.
 *
 * Returns what to show while that's being settled, or null to carry on.
 */
/**
 * Routes that don't need this device to hold a season.
 *
 * Browsing is public — a parent opening a link to results has no account, no
 * team, and nothing in local storage, and sending them to a sign-in screen
 * would defeat the entire point of publishing results. The deck screens still
 * require a season, because a stopwatch with no roster behind it is useless.
 */
const PUBLIC_PREFIXES = ["/teams", "/athletes", "/meets"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function useSeasonForSession(publicPath: boolean): string | null {
  const { ready, hasLocalData, chooseTeam, team } = useAppStore();
  const session = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // One adoption at a time, and never the same team twice: `chooseTeam`
  // changes the store, which re-runs this effect.
  const adopting = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || session.status === "loading") return;
    // A visitor reading a public page is not a device that has lost its
    // season, and must not be redirected as though it were.
    if (publicPath) return;

    if (!hasLocalData) {
      if (session.status === "out") {
        navigate("/sign-in", { replace: true });
        return;
      }
      if (!session.openTeamId) {
        navigate("/join", { replace: true });
        return;
      }
    }

    const wanted = session.openTeamId;
    if (!wanted || wanted === team.id || adopting.current === wanted) return;

    // A device already working in a season this person belongs to stays put.
    // Following `openTeamId` here would drag a coach off the team they're
    // standing beside every time they opened the app on a second one.
    const belongsHere = session.memberships.some(
      (m) => m.teamId === team.id && m.status === "active",
    );
    if (hasLocalData && belongsHere) return;

    adopting.current = wanted;
    chooseTeam(wanted)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Couldn't load that season."),
      )
      .finally(() => {
        adopting.current = null;
      });
  }, [ready, hasLocalData, publicPath, session, team.id, chooseTeam, navigate]);

  // Keep the account's idea of where this person is up to date, so their next
  // device opens the same place. Guarded by what was last sent rather than by
  // what came back, since recording it updates the session and would otherwise
  // set this off again.
  const remembered = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !hasLocalData || session.status !== "in") return;
    if (!session.memberships.some((m) => m.teamId === team.id && m.status === "active")) {
      return;
    }
    const place = `${team.id}:${team.currentSeasonId}`;
    if (remembered.current === place) return;
    remembered.current = place;
    session.rememberPlace(team.id, team.currentSeasonId);
  }, [ready, hasLocalData, session, team.id, team.currentSeasonId]);

  if (error) return error;
  if (!hasLocalData) return "";
  return null;
}

export default function Shell() {
  const { ready, storageError, hasLocalData, team, athletes, meets } = useAppStore();
  const location = useLocation();
  const publicPath = isPublicPath(location.pathname);
  const settling = useSeasonForSession(publicPath);
  const status = useSyncStatus();
  const { laneLayout, setLaneLayout } = useViewPrefs();
  const params = useParams();

  if (storageError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-bold">Can&rsquo;t open this device&rsquo;s storage</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {storageError}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Nothing has been lost — the season is still on this device and on
            the server.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  // This device has no season yet — either it's on its way, or fetching it
  // failed and there's something to say about that. Public pages render
  // regardless: they read from the server and need nothing local.
  if (settling !== null && !publicPath) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        {settling ? (
          <div className="max-w-sm">
            <p className="text-lg font-bold">Couldn&rsquo;t open that season</p>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {settling}
            </p>
          </div>
        ) : (
          <p className="text-slate-400">Loading…</p>
        )}
      </div>
    );
  }

  const openMeet = params.meetId
    ? meets.find((m) => m.id === params.meetId)
    : undefined;
  const tabs = openMeet ? meetTabs(openMeet.id) : TOP_TABS;
  const chip = syncLabel(status);

  const onRegistration = location.pathname.endsWith("/registration");
  const onRun = location.pathname.endsWith("/run");
  const rawGender = new URLSearchParams(location.search).get("g");
  const genderParam = rawGender === "f" || rawGender === "m" ? rawGender : "all";

  // Rearranging the stop buttons under a running clock is how a lane gets
  // missed, so the layout is fixed until the heat is off the clock.
  const heatLive = openMeet?.timer != null;
  const toggles = onRegistration ? (
    <HeaderToggles
      label="Filter roster by gender"
      options={genderOptions(location.pathname, genderParam)}
    />
  ) : onRun && openMeet ? (
    <HeaderToggles
      label="Stopwatch button layout"
      disabled={heatLive}
      options={layoutOptions(
        openMeet.options.laneCount,
        laneLayout,
        setLaneLayout,
      )}
    />
  ) : null;

  const title =
    openMeet?.name ?? (hasLocalData || !publicPath ? team.name : "Meet Runner");
  const subtitle = onRegistration
    ? undefined
    : openMeet
      ? meetSubtitle(openMeet)
      : location.pathname.startsWith("/team") ||
          location.pathname.startsWith("/athletes")
        ? `${rosterFor(athletes, team, team.currentSeasonId).length} swimmers · ${currentSeason(team)?.name ?? ""}`
        : undefined;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-30 h-[var(--app-chrome-top)] border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        {/* Three columns so the filter is centred on the header itself rather
            than wherever the title and chip happen to leave it — equal `1fr`
            sides keep it put at every width. Without the filter there's
            nothing to centre, so the title takes the whole leftover instead of
            being needlessly capped at half. Width tracks `main` so "left" and
            "right" mean the window edges on the full-bleed grid. */}
        <div
          className={`mx-auto grid h-full items-center gap-3 px-4 ${
            toggles
              ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
              : "grid-cols-[minmax(0,1fr)_auto]"
          } ${onRegistration ? "max-w-none" : "max-w-3xl"}`}
        >
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight">{title}</h1>
            {subtitle && (
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {subtitle}
              </p>
            )}
          </div>

          {toggles && <div className="justify-self-center">{toggles}</div>}

          <span
            className={`justify-self-end rounded-full px-2 py-1 text-xs font-semibold ${CHIP_TONES[chip.tone]}`}
          >
            {chip.text}
          </span>
        </div>
      </header>

      {/* Bottom padding clears the fixed tab bar, including the iOS home bar.
          The registration grid opts out of the centered column so its event
          columns can spread across the full window. */}
      <main
        className={`mx-auto px-4 pt-4 pb-[calc(var(--app-chrome-bottom)+1rem)] ${
          onRegistration ? "max-w-none" : "max-w-3xl"
        }`}
      >
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex h-[var(--app-nav-h)] max-w-3xl">
          {tabs.map((tab) => {
            // The back arrow points at the meet list, which would otherwise
            // light up as the active tab while you're inside a meet.
            const isBackLink = openMeet !== undefined && tab.to === "/meets";
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `flex flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                    isActive && !isBackLink
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-slate-500 dark:text-slate-400"
                  }`
                }
              >
                <span aria-hidden className="text-xl leading-none">
                  {tab.icon}
                </span>
                {tab.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

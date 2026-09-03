import { Link, NavLink, Outlet, useLocation, useParams } from "react-router";
import { useAppStore } from "~/state/app-store";
import { syncLabel, useSyncStatus } from "~/state/auto-sync";
import { meetSubtitle } from "~/types/meet";

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
 * Girls / Boys toggles for the registration grid. Lives in the header so it
 * costs no vertical space on the one screen that wants every pixel, and rides
 * on a search param so the grid needn't share state with the chrome.
 *
 * There's no "All" button: showing everyone is the default, and tapping the
 * active filter is the way back to it.
 */
function GenderFilter({
  pathname,
  current,
}: {
  pathname: string;
  current: string;
}) {
  const options = [
    { value: "f", label: "Girls" },
    { value: "m", label: "Boys" },
  ];

  return (
    <div
      role="group"
      aria-label="Filter roster by gender"
      className="flex shrink-0 overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
    >
      {options.map((option, index) => {
        const active = current === option.value;
        const label = active
          ? `${option.label} only — tap to show everyone`
          : `${option.label} only`;
        return (
          <Link
            key={option.value}
            // Tapping the active one clears the filter; tapping the other
            // swaps to it. Either way only one can be on.
            to={active ? pathname : `${pathname}?g=${option.value}`}
            replace
            title={label}
            aria-label={label}
            aria-current={active ? "true" : undefined}
            className={`flex h-8 touch-manipulation items-center justify-center px-3 text-xs font-bold transition-colors ${
              index > 0 ? "border-l border-slate-300 dark:border-slate-700" : ""
            } ${
              active
                ? "bg-blue-600 text-white"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

export default function Shell() {
  const { ready, team, meets } = useAppStore();
  const status = useSyncStatus();
  const location = useLocation();
  const params = useParams();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  const openMeet = params.meetId
    ? meets.find((m) => m.id === params.meetId)
    : undefined;
  const tabs = openMeet ? meetTabs(openMeet.id) : TOP_TABS;
  const chip = syncLabel(status);

  const onRegistration = location.pathname.endsWith("/registration");
  const rawGender = new URLSearchParams(location.search).get("g");
  const genderParam = rawGender === "f" || rawGender === "m" ? rawGender : "all";

  const title = openMeet?.name ?? team.name;
  const subtitle = onRegistration
    ? undefined
    : openMeet
      ? meetSubtitle(openMeet)
      : location.pathname.startsWith("/team")
        ? `${team.swimmers.filter((s) => !s.archived).length} swimmers · ${team.season}`
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
            onRegistration
              ? "max-w-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
              : "max-w-3xl grid-cols-[minmax(0,1fr)_auto]"
          }`}
        >
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight">{title}</h1>
            {subtitle && (
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {subtitle}
              </p>
            )}
          </div>

          {onRegistration && (
            <div className="justify-self-center">
              <GenderFilter
                pathname={location.pathname}
                current={genderParam}
              />
            </div>
          )}

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

import { Link } from "react-router";

/**
 * Switching between the browse lists.
 *
 * These three answer the same question from different angles — who is out
 * there — so they read better as one surface with three views than as three
 * unrelated pages reachable only from a tab bar with room for one of them.
 */
export function BrowseNav({ here }: { here: "teams" | "athletes" | "meets" }) {
  const views = [
    { key: "teams", to: "/teams", label: "Teams" },
    { key: "athletes", to: "/athletes", label: "Athletes" },
    { key: "meets", to: "/meets", label: "Meets" },
  ] as const;

  return (
    <nav className="flex gap-2" aria-label="Browse">
      {views.map((view) => (
        <Link
          key={view.key}
          to={view.to}
          aria-current={view.key === here ? "page" : undefined}
          className={`min-h-10 flex-1 rounded-xl border-2 text-center text-sm font-bold leading-10 transition-colors ${
            view.key === here
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          }`}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}

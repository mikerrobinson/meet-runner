import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useSession } from "~/state/session";

/** Up to two letters from a name, or the first of a contact. */
function initials(name: string | null, contact: string): string {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/);
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : ""))
      .toUpperCase();
  }
  return (contact.replace(/^[^a-z0-9]*/i, "")[0] ?? "?").toUpperCase();
}

/**
 * The account control every site has in its top right corner.
 *
 * Deliberately unremarkable — people already know what a circle in that corner
 * does, and spending novelty on it would only make it slower to find. Signed
 * out it's a plain "Log in", because a circle with a question mark in it
 * doesn't tell anyone what to press.
 */
export function AccountMenu() {
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Clicking elsewhere, or Escape, closes it. Both are what a menu is expected
  // to do, and neither happens for free.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (session.status !== "in" || !session.user) {
    return (
      <Link
        to="/sign-in"
        className="shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-800"
      >
        Log in
      </Link>
    );
  }

  const user = session.user;

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white"
      >
        {initials(user.name, user.contact)}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <p className="truncate text-sm font-semibold">
              {user.name ?? "Your account"}
            </p>
            <p className="truncate text-xs text-slate-500">{user.contact}</p>
          </div>

          <Link
            to={`/users/${user.id}`}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Your teams and times
          </Link>
          <Link
            to="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Profile
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void session.signOut().then(() => navigate("/sign-in"));
            }}
            className="block w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

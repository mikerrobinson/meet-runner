import { redirect } from "react-router";

/**
 * Where the app opens. There's no separate dashboard — the schedule is it.
 *
 * Anything navigating "home" should come here rather than to `/`, because a
 * client-side navigation to bare `/` renders nothing at all. The basename is
 * `/projects/meet-runner/`, trailing slash included (Vite's `BASE_URL`
 * convention, and every asset URL depends on it), and once that is taken off
 * the front of `/projects/meet-runner/` there is no path left for the router
 * to match: it settles on the new URL, mounts no route, fetches nothing, and
 * raises no error. A full page load is fine, because the server matches the
 * route itself — which is what made this look like a heisenbug, since
 * reloading the blank page fixed it.
 *
 * Signing in landed here, so that blank page was the first thing a new coach
 * saw.
 */
export const APP_HOME = "/meets";

/** Still a real route, for a bookmark or the home-screen icon. */
export function loader() {
  return redirect(APP_HOME);
}

export default function Home() {
  return null;
}

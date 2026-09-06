import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { AutoSyncProvider } from "./state/auto-sync";
import { AppStoreProvider } from "./state/app-store";
import { SessionProvider } from "./state/session";
import { ViewPrefsProvider } from "./state/view-prefs";
import "./app.css";

/**
 * Assets in `public/` are served under the router basename, so home-screen
 * icons and the manifest have to be addressed through it — a bare "/icon.png"
 * would 404 in production.
 */
const base = import.meta.env.BASE_URL;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover so the tab bar can sit under the iOS home bar. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />

        {/* Home-screen install. iOS reads the apple-* tags; everything else
            reads the manifest. Without an apple-touch-icon iOS would use a
            screenshot of the page as the icon. */}
        <link rel="manifest" href={`${base}manifest.webmanifest`} />
        <link rel="apple-touch-icon" href={`${base}icon-180.png`} />
        <link rel="icon" type="image/png" sizes="192x192" href={`${base}icon-192.png`} />
        <link rel="icon" href={`${base}favicon.ico`} sizes="any" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Meet Runner" />
        {/* "default" keeps the web view below the status bar, so the layout
            needs no special case; the status bar picks up theme-color. */}
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="Meet Runner" />

        <meta
          name="theme-color"
          content="#f8fafc"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#020617"
          media="(prefers-color-scheme: dark)"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Session sits outside the store: who you are decides which season the store
  // is asked to load, so it has to be settled first.
  return (
    <SessionProvider>
      <AppStoreProvider>
        <AutoSyncProvider>
          <ViewPrefsProvider>
            <Outlet />
          </ViewPrefsProvider>
        </AutoSyncProvider>
      </AppStoreProvider>
    </SessionProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Not found" : "Error";
    details =
      error.status === 404
        ? "That page doesn't exist."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">{message}</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">{details}</p>
      <p className="mt-4 text-sm text-slate-500">
        Your meet is saved on this device — reloading won't lose it.
      </p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-xl bg-slate-100 p-4 text-xs dark:bg-slate-900">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

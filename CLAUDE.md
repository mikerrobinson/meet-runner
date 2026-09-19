# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An app for running a high-school swim meet from a pool deck: rosters that carry across seasons, an entries grid, and the timing itself — volunteer timers behind lanes, coaches with multi-lane stopwatches, and an administrator running the control desk. React Router 7 (framework mode) on Cloudflare Workers, D1 + a per-meet Durable Object for storage, Tailwind v4 for styling.

**Read `README.md` before making non-trivial changes.** It is the actual design doc — the domain model (athletes/teams/meets/enrollments), the evidence-vs-decision distinction between watches and results, the timing-tier rules, the D1/Durable-Object split, the two client write queues, and the permissions model are all explained there in depth and are not repeated here.

## Commands

```sh
npm install
npm run dev          # react-router dev, http://localhost:5173/
npm run typecheck     # wrangler types + react-router typegen + tsc -b (project references)
npm test              # runs every tests/*.test.ts
npm run build         # react-router build
npm run deploy        # build + wrangler deploy
npm run preview       # build + vite preview
npm run icons         # regenerate public/ icons from source art
```

- `wrangler dev` (via `npm run dev`) spins up a local D1 and the Durable Object's local SQLite storage automatically; `ensureSchema()` (`app/lib/schema.server.ts`) creates any missing tables on first use.
- `.dev.vars` sets `AUTH_DEV_CODES=1` so sign-in codes are returned straight to the browser instead of sent by email/SMS — never set this on a deployed worker. It's gitignored.
- No lint/format config exists in this repo (no eslint/prettier). Rely on `npm run typecheck`.

### Running a single test

There's no test framework — each `tests/*.test.ts` is run directly under Node with type-stripping. To run one suite in isolation:

```sh
node --experimental-strip-types --experimental-transform-types --no-warnings \
  --import tests/resolve-alias.mjs tests/timing.test.ts
```

`tests/run.mjs` is what `npm test` calls; it just runs every suite in `tests/` this way and reports pass/fail per suite. `tests/resolve-alias.mjs` resolves the `~/` import alias so tests don't need a build step.

## Architecture

**D1 is the durable, cross-meet source of truth** for teams, seasons, athletes, enrollments, accounts, and a meet's own setup (`meets`/`events`). **A meet's live race-day state — `seeds`, `watches`, `results`, `entries` — lives in that meet's own Durable Object** (`env.MEET_DO.getByName(meetId)`), hydrated from D1 and checkpointed back to it. Every write to those four tables goes to the DO, never straight to D1; every loader reads meet setup from D1 and the live tables from the DO's `getSnapshot()`. Changes push to connected clients over a WebSocket (`GET /api/meets/:meetId/live`) instead of being polled for. Full detail, including why, is in README's "Architecture" section.

```
app/lib/schema.server.ts   D1 tables
app/lib/meet-do.server.ts  the per-meet Durable Object: live seeds/watches/results/entries, hydration, checkpointing, WS broadcast
app/lib/meet-live.ts       client-side WebSocket connection + snapshot cache
app/hooks/use-meet-live.ts subscribe a screen to the live snapshot (admin, splits, entries, results, event-detail)
app/hooks/use-meet-changes.ts "something changed" only, for the timer workspace
app/lib/meets.server.ts    meet setup reads/writes against D1
app/lib/teams.server.ts    teams, seasons, enrollments, roster
app/lib/athletes.server.ts people, and the account link
app/lib/access.ts          who may do what — pure predicates
app/lib/access.server.ts   who the current user is, from the database
app/lib/timing.ts          watches → proposed time; results; closing (pure)
app/lib/heats.ts           seeding and reseeding (pure)
app/lib/events.ts          lineups and entry limits (pure)
app/lib/public.ts          what anyone may see, and the redaction (pure)
app/lib/public.server.ts   the browse/loader queries
app/lib/writes.ts          the `Write` union — the one wire vocabulary shared by both write endpoints and the client overlay
app/lib/outbox.ts          localStorage write queue (admin/coach), draining to api.meet.writes.ts
app/lib/pending.ts         applyWrite/applyPending — the optimistic overlay reducer (pure), shared by outbox and meet-live
app/lib/timer-queue.ts     cookie-based write queue for the timer workspace (storage-hostile phones)
app/lib/timer-messages.ts  encode/decode for the timer cookie queue
```

Key patterns worth internalizing (fully explained in README):

- **Rows several people write at once are keyed so writes can't collide** — concurrency is a property of primary keys (`event_id, heat, lane`, `seed_id, timer_id`, etc.), not something reconciled after the fact. The Durable Object serializes writes per meet, so there's no concurrent execution left to collide in either.
- **A watch is evidence, never overwritten; a result is a decision**, written once by an administrator and immutable once decided. `laneTime()`/`timing.ts` resolves multiple watches into a proposed time by tier (admin's own reading > timers by hand-timing median rules > coaches averaged), never mixing tiers.
- **Two independent client-side write queues exist on purpose, not by accident**: `outbox.ts` (localStorage, for admin/coach) and `timer-queue.ts` (cookies, because a timer's phone may refuse localStorage entirely — it's a stranger's phone opened from a camera app). Don't merge them; the constraints genuinely differ. Both fold through the same `applyWrite`/`applyPending` reducer in `pending.ts` — if you change what a `Write` does to state, update it there **and** in `meet-do.server.ts`'s matching RPC method, which has to agree with it.
- **Permissions are computed in the loader**, from the same `access.ts` predicates used by the write endpoints, so a button and its endpoint can't disagree about who may press it. Every write endpoint re-checks server-side regardless of what the UI showed.
- **`.server.ts` modules must not be imported by components** — the build enforces this (React Router server/client split). Logic needed by both sides goes in the paired pure module (`access.ts` beside `access.server.ts`, `public.ts` beside `public.server.ts`).
- **Only two fields are private**: birth dates and contact details. `public.ts` builds public views by naming which fields *may* travel, not by deleting the ones that mustn't — so a new field on a type is private by default.
- **The timer workspace's URL *is* device position** (`/meets/:meetId/timer/:event/:heat/:lane`) — no client state tracks "where this phone is." Deliberate: bookmarkable, back-button-able, survives a reload, and lets someone be read their position over the phone.
- **Deletes are real deletes** — no tombstones, nothing else holds a copy to restore from.
- **Reseeding refuses once anything is recorded against an event** and reuses existing seed ids in place; a fresh id would orphan every watch/result pointing at the old one.
- **The DO checkpoints to D1 every five minutes and at meet close, not on every write** — a screen reading the live tables must go through the DO (`getSnapshot()`), never a plain D1 read, or it shows stale state.

See `TODOS.md` for open questions and known rough edges (not a committed roadmap).

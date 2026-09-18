# Migration Plan: Durable Objects, RESTful Routing, Remix-Native Offline

Status: **planning — no code written yet.** This document exists so the
rewrite can be picked up across sessions without re-deriving the reasoning
each time. It supersedes nothing in `route-design.md` or `gemini-design.md`
— it's the bridge between those and the actual code.

This is a **single coordinated rewrite**, not an incremental migration. The
app has no production data (D1 and any Durable Object storage start empty),
so nothing here adds backward-compatibility shims, dual-write paths, feature
flags, or support for "the old shape." Where the current schema has a
migration array or a compat check, the plan is to delete it, not extend it.

**Prep already done, ahead of the rewrite itself:** what used to be
`run.tsx` (a combined screen with an in-page toggle between a control desk
and a multi-lane stopwatch, plus `run-control.tsx` for the desk half) has
been split into two real routes — `app/routes/admin.tsx`
(`/meets/:meetId/admin`) and `app/routes/splits.tsx`
(`/meets/:meetId/splits`) — as a straight extraction, no behavior change.
This means the "splits" workspace in `route-design.md`/`gemini-design.md`
was never actually new functionality — it's the multi-lane stopwatch that
already existed, just buried behind a toggle only an administrator could
see. See the corrections to §2 and §3.3 below.

---

## 1. Problem statement

Three separate decisions made early are now fighting the app's own growth:

**Polling.** `app/hooks/use-live-data.ts` revalidates the _entire_ meet
loader every 3s on any screen that calls it; `app/lib/timer.ts` runs a
second, independent 10s poll for timer phones. Both exist because nothing
tells a screen when something changed — it has to keep asking. At even
small live-meet scale this burned through free-tier Workers requests and D1
row reads; paying for the tier doesn't fix the design, it just raises the
ceiling before it hurts again.

**URL structure.** The timer workspace already addresses position in the
URL (`/meets/:meetId/timer/:event/:heat/:lane` — see `routes.ts`), but
admin and splits do not: `app/routes/admin.tsx` and `app/routes/splits.tsx`
(split out of a combined `run.tsx`/`run-control.tsx` as prep for this
rewrite — see the note above) each track the open event/heat in `useState`
or local-storage `loadProgress`/`saveProgress`, not the URL.
`results.tsx` picks its view (`by-event`, `team-scores`, …) via `?view=`
rather than a path segment. Three workspaces, three different patterns,
none of them bookmarkable or back-button-able the way the timer one
already is.

**Offline machinery.** There are, today, _two_ independent offline-write
systems doing conceptually the same job:

- `app/lib/outbox.ts` + `app/lib/pending.ts` — a localStorage queue of
  `Write` objects (the closed union in `app/lib/writes.ts`), flushed to
  `POST /api/meets/:meetId/writes`, overlaid onto loader data by
  `applyPending` so a tap feels instant before the server has answered.
- `app/lib/timer-queue.ts` + `app/lib/timer-messages.ts` — a _cookie_-based
  queue, deliberately not localStorage, because a timer's phone may be a
  parent's personal phone in a locked-down or private-browsing webview
  where site storage is refused. Payload cookies are scoped to the lane's
  own URL so the browser does both the addressing and the de-duplication.

The duplication isn't a mistake — the two have a genuinely different
constraint driving them — but the amount of hand-rolled state management on
top of both is exactly the "longer and less readable than it should be"
problem. Fixing it isn't "delete one," it's "make each as small as the
constraint that justifies it, and stop overlapping."

---

## 2. Goals

1. Real-time push instead of polling, via a Durable Object per meet.
2. Hierarchical, REST-shaped routing per `route-design.md`, consistently
   across public, timer, admin, and coach (splits) workspaces.
3. Replace the hand-rolled outbox/overlay machinery with React Router's
   `clientLoader`/`clientAction`, _except_ where a real constraint (the
   timer's storage-hostile webviews) still requires something bespoke —
   in which case keep exactly that much bespoke code, not more.
4. No backward compatibility, no migration shims, no dead code paths for
   "how it used to work." This is a from-empty-database rewrite.
5. Live push reaches all four roles: admin, coach, timer, and spectator —
   including the spectator live-results view, which doesn't exist yet and
   is being designed for from the start rather than bolted on later.

### Non-goals (this pass)

- Redesigning the entries UX. `/meets/:meetId/entries` keeps its current
  URL and its current whole-meet grid (`entries.tsx`, unchanged) — this is
  confirmed, not an open question. The new `/meets/:meetId/:eventId`
  public leaf (§3.3) doesn't replace or absorb it.

---

## 3. Target architecture

### 3.1 Data ownership: D1 vs. the meet's Durable Object

D1 remains the durable, cross-meet source of truth. A Durable Object,
one per meet, owns the _live, multi-writer, race-day_ state for exactly
the duration of that meet.

**Stays in D1, always:**
`teams`, `seasons`, `athletes`, `enrollments`, users/identities/sessions
(`auth.server.ts`), `meet_grants` (`grants.server.ts`), and the `meets` /
`events` rows themselves — meet setup and the programme, decided before
race day, not written by multiple people at once.

**Owned live by the meet's DO, hydrated from D1 at meet start, dumped
back to D1 at meet end:**
`seeds`, `watches`, `results`, `entries` — precisely the tables
`schema.server.ts`'s own comments already single out as "written by
several people at once." These move into the DO's private SQLite storage
for the meet's duration. The DO serializes every write itself (Durable
Objects process one request at a time per instance), which is what
actually eliminates the need for a lot of the current row-keying-for-safety
design — there's no concurrent execution left to collide in.

**The deck-entry exception.** Adding a walk-up swimmer creates an
`athletes` row and an `enrollments` row — both global, both needed by
screens outside this meet (team rosters, athlete profiles) — so they
can't live only in a per-meet DO and can't wait for an end-of-meet dump;
a later heat needs to see the new name in a dropdown within the same
meet. Resolution: **that write goes straight to D1 the moment it
happens**, same as any other roster edit today. As a side effect, the
Worker tells the meet's DO about the new athlete (it adds it to a small
in-memory/local roster cache it holds for rendering names against seeds)
and the DO broadcasts it to every connected client — same mechanism as a
seed or watch update, just sourced from a direct D1 write instead of
DO-owned state. Rule of thumb going forward: **D1 is written to
immediately for anything global; the DO is written to immediately for
anything meet-scoped; either kind of change is broadcast live.**

**Sync timing.** End-of-meet dump, not a mirror on every write. DO SQLite storage is itself
durably persisted (not in-process memory that's lost on eviction), so this
isn't the durability risk it would be for an in-memory cache — the
periodic checkpoint is insurance against something exotic, not the
primary durability mechanism.

### 3.2 The Meet Durable Object

- One instance per meet: `env.MEET_DO.getByName(meetId)`.
- `new_sqlite_classes` migration in `wrangler.jsonc`; the DO also binds
  `DB` (D1) directly, same as a Worker, so it can hydrate itself and
  perform the end-of-meet dump without a second hop through the Worker.
- Constructor uses `blockConcurrencyWhile` only for schema setup
  (idempotent `CREATE TABLE IF NOT EXISTS`, same idiom `schema.server.ts`
  already uses) — never for hydration or per-request work.
- **RPC methods mirror the existing `Write` union** in `lib/writes.ts`
  almost one-to-one: `seat`, `unseat`, `setExhibition`, `recordWatch`,
  `dropWatch`, `decideResult`, `undecideResult`, `declareEntry`, plus
  `addWalkupAthlete` (D1 write + local cache update, as above) and
  `getSnapshot` (full current state, for a fresh client's initial paint).
  Reusing the `Write` shape as the RPC/broadcast vocabulary means the
  existing reducer in `lib/pending.ts` (`applyPending`) can be generalized
  into the one function that both (a) overlays this device's own
  optimistic writes and (b) applies an incoming broadcast from the DO to
  the cached snapshot. One reducer, two callers, instead of two.
- **WebSocket hibernation API**, not a plain long-lived socket: connections
  sit idle between heats without the DO being billed for active duration,
  which is the actual mechanism that fixes the Cloudflare bill — you pay
  for events (a write, a connect/disconnect), not for tabs left open.
  Connections are tagged by role (admin / coach / timer / spectator) via
  `serializeAttachment`, so broadcast filtering (e.g. a spectator payload
  that omits which specific timer submitted a raw watch time) is possible
  later without redesigning the transport.
- **Auth happens before the DO sees the request.** The Worker's fetch
  handler validates the session (admin/coach, via `access.server.ts`) or
  the grant token (timer, via `grants.server.ts`) or allows the connection
  unauthenticated (spectator, read-only) _before_ forwarding the upgrade
  into the DO stub. The DO receives an already-resolved role/identity, not
  a cookie jar to parse — keeps `access.server.ts`/`grants.server.ts` as
  the one place auth logic lives.

### 3.3 Routing

Target tree, per `route-design.md`, with notes on what each replaces:

| Route                                            | Replaces                            | Notes                                                                                                          |
| ------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/meets`                                          | `meets.tsx`                         | Unchanged in shape.                                                                                            |
| `/meets/:meetId`                                  | `meet-layout.tsx` + `meet-info.tsx` | Loader shrinks to meet metadata + access only — see below.                                                     |
| `/meets/:meetId/:eventId`                         | part of `results.tsx`               | New public, read-only event-detail leaf: declared entries, seeds, current results for one event. Does not replace `entries.tsx` — see §2 non-goals. |
| `/meets/:meetId/entries`                          | `entries.tsx`                       | Unchanged — out of scope, see §2 non-goals.                                                                    |
| `/meets/:meetId/results`                          | `results.tsx` (index)               | Selector only.                                                                                                 |
| `/meets/:meetId/results/:view`                    | `results.tsx` (view switch)         | `by-event` / `by-swimmer` / `team-scores` as path segments, not `?view=`.                                      |
| `/meets/:meetId/timer`                            | `timer-lanes.tsx`                   | Same shape as today; data source becomes the DO.                                                               |
| `/meets/:meetId/timer/:event/:heat/:lane`         | `timer.tsx`                         | Already the right shape — no routing change, only the data/offline layer underneath.                          |
| `/meets/:meetId/admin`                            | `admin.tsx` (already its own route) | Becomes the WS-connected shell; `openEvent` still needs to move from `useState` into the URL.                  |
| `/meets/:meetId/admin/:event/:heat`               | `admin.tsx`'s heat desk             | Event/heat move into the URL; this is the main routing rewrite.                                                |
| `/meets/:meetId/splits`                           | `splits.tsx` (already its own route)| Not new — the existing multi-lane stopwatch, split out ahead of this rewrite. Rides along with admin, not deferred. |
| `/meets/:meetId/splits/:event/:heat`              | `splits.tsx`'s stopwatch            | Event/heat move from `loadProgress`/`saveProgress` local storage into the URL — same shape of change as admin. |

**`meet-layout.tsx`'s current loader — loading the entire `MeetDetail`
(all events, entries, seeds, watches, results) once for every child route —
is itself part of the anti-pattern being replaced**, independent of
polling. Under the target design it shrinks to meet metadata + access
(cheap, rarely-changing, fine to keep as a parent loader), and each leaf
route loads or subscribes to only what it needs: the admin/timer leaves
via the DO connection, the public/results leaves via plain D1 reads (see
§3.4 on whether those get push or stay request/response).

### 3.4 Offline / data-fetching pattern

**Admin and coach workspaces** (trusted devices — a desk laptop/tablet,
JS storage available): `clientLoader` reads from a small local cache
(the last snapshot the DO sent, kept in localStorage/IndexedDB) for
instant paint and offline resilience on reload, kept current by the WS
subscription. `clientAction` applies a write optimistically via the
shared reducer (generalized `applyPending`), sends it to the DO, and — if
offline — queues it. That queue is a **successor to `outbox.ts`, not its
deletion**: coalescing ("two answers about the same lane is one answer")
needs a view across the whole meet's pending writes, not one scoped to a
single route's `clientAction`, so a small shared module is still the
right shape. The win from moving to `clientAction` is that the wiring
between a form submission and that shared queue becomes React Router's
own mechanism instead of a hand-rolled `useSend()`/`usePending()` pair —
not that the queue itself disappears.

**Timer workspace** keeps the cookie-based queue
(`timer-queue.ts`/`timer-messages.ts`), because the constraint that
produced it — a phone that may refuse localStorage entirely — is
unrelated to polling or routing and doesn't go away. `clientAction` here
stages the cookie exactly as `enqueueSeat`/`enqueueStart`/etc. do today;
what changes is that confirmation now arrives as a DO broadcast (so an
admin screen sees a submitted time land immediately) instead of the next
manual poll.

**Public/results views**: plain server `loader`, SSR from D1 pre-meet.
Whether they also subscribe to the DO for live push during a running meet
is answered by §2's goal 5 (yes — spectators are in scope for live push),
but the _payload_ they receive over that connection should likely be
narrower than the admin/timer one (results and heat status, not raw
per-timer-watch detail) — flagged as a product decision in §6, not a
blocker to building the DO's broadcast mechanism generally.

---

## 4. What gets deleted, not just replaced

- `app/hooks/use-live-data.ts` — the polling hook, entirely.
- The `setInterval`/`visibilitychange` polling loop in
  `app/lib/timer.ts`'s snapshot fetch.
- `schema.server.ts`'s `MIGRATIONS` array — folded into the base
  `CREATE TABLE` statements; no ALTER-TABLE-for-existing-rows logic
  anywhere, since there are no existing rows.
- `grants.server.ts`'s `ensureGrantStore` compat check (the dropped
  `team_id` column handling) — same reasoning, delete rather than carry
  forward.
- Once the admin/splits routing rewrite lands: `admin.tsx`'s `openEvent`
  `useState` and `splits.tsx`'s `loadProgress`/`saveProgress` local-storage
  position, both replaced by URL params (`/admin/:event/:heat`,
  `/splits/:event/:heat`).

---

## 5. Implementation order (within the one branch)

Even as a single coordinated rewrite, building it in this order keeps
each stage testable against something real before the next depends on it:

1. **Schema & wrangler foundations.** Collapse `schema.server.ts` to a
   clean base schema (no migrations array); add the DO binding and
   `new_sqlite_classes` migration to `wrangler.jsonc`; scaffold the DO
   class with its own schema init.
2. **Meet Durable Object core.** Storage schema, D1 hydration on first
   use, the RPC write methods mirroring `Write`, hibernating WebSocket
   accept/broadcast, the Worker-side auth handshake before upgrade,
   end-of-meet D1 dump + periodic checkpoint.
3. **Shared client data layer.** Generalize `pending.ts`'s reducer to
   double as the broadcast-apply function; build the WS-subscribing
   hook/store; slim successor to `outbox.ts` for admin/coach; adapt
   `timer-queue.ts` to talk to the DO instead of the current
   `api.timer.lane.ts` endpoint, keeping its cookie mechanism intact.
4. **Routing rewrite.** New route tree per §3.3; split `meet-layout.tsx`
   into the thin metadata loader; move `admin.tsx` and `splits.tsx`
   (already separate route files) onto URL-driven event/heat; split
   `results.tsx` into index + `:view` leaf; add the `:eventId` public leaf.
5. **Wire per workspace, in order: timer → admin/splits → public/results.**
   Timer first because its routing is already correct and it isolates
   the DO/offline changes from the routing changes; admin and splits
   second, together, since they're siblings split from the same code this
   session and share the same DO wiring and heat-desk concepts;
   public/results last since it's the lowest-risk, most-standard piece.
6. **Cleanup.** Delete everything in §4; grep for any remaining
   `setInterval`-based revalidation and remove it; confirm the outbox
   successor and the timer cookie queue are the _only_ two client-side
   write-queuing mechanisms left, and that neither has grown a third
   sibling by accident.
7. **Deferred, tracked but not built this pass:** the spectator
   live-results UI's actual screen — the DO plumbing for it ships in step
   2–3, but the screen itself doesn't exist yet.

---

## 6. Open decisions to confirm before/while implementing

- **Spectator broadcast payload shape** — full state vs. a filtered
  subset (results/heat status only). Not a blocker for building the DO's
  broadcast mechanism, but worth deciding before the spectator screen is
  actually built.
- **Shared outbox module shape** (§3.4) — this plan assumes one small
  shared queue module still exists for admin/coach, called from each
  route's `clientAction`, rather than fully independent per-route queues.
  Worth a second look once the admin workspace is actually being built,
  in case the coalescing rules turn out simpler than expected once writes
  go through a serializing DO instead of racing at D1.

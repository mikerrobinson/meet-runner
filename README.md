# Swim Starts

An app for running a high-school swim meet from a pool deck: rosters that carry
across seasons, a schedule of meets, an entries grid, and the timing itself —
volunteers with phones behind each lane, a coach with a multi-lane stopwatch,
and an administrator at a table deciding what stands.

The shape of the problem is the paper system it replaces. Two or three timers
stand behind each lane with stopwatches, take a time, and write the team, the
name and the time on a sheet. A runner hands the sheets to an administrator,
who types them in and scores the meet. This app crowd-sources that data entry
and pre-fills it from each team's entries. **Where the app disagrees with the
paper, the paper is usually right.**

---

## The model

Three things, and only one of them owns anything.

**Athletes** are people — global and durable. A swimmer is one record whether
they swim for a school, a club, or both, so fixing a spelling in March fixes
January's results too. Nobody is ever deleted, because results reference
people by id forever.

**A team** owns its seasons and says, through _enrollments_, who swam for it
and when. It does not hold its athletes — that's what lets two schools racing
the same swimmer point at one person rather than keeping a copy each, and
keeps a visiting swimmer off the home roster. A team can exist with nobody
coaching it (an _unclaimed_ team, minted when a meet names an opponent that's
never used the app); a coach from there takes it on later.

**A meet** is one day's racing between one or more teams, and belongs to none
of them. It references teams by id, so a dual meet is one shared thing both
schools open, rather than two half-copies.

---

## Running a meet

**A `seed` is one planned swim** — an athlete in an event, at a heat and lane
— keyed by `(event, heat, lane)` so the coach seeding it, the administrator
correcting the desk, and the timer fixing a name behind the blocks all write
the same row, last write wins. Its `id` outlives the lane: watches and results
point at the seed, not at a lane number, so moving someone doesn't orphan
their time. There is no separate heats table — a heat is just the distinct
heat numbers across an event's seeds, so a heat cannot exist with nothing in
it.

**A `watch` is evidence and is never overwritten.** One row per submitter per
seed (`timerId`), so an extra watch never overwrites anybody's. Times
truncate to hundredths, never round up — a time you didn't swim is not a time.
A watch with a `startedAt` and no `timeMs` is a stopwatch still running, which
is how the desk tells "nobody's covering this lane" from "the timers are still
holding their clocks."

**A `result` is the decision, and there is at most one per seed.** Written
only by an administrator; its existence *is* the sign-off — there's no flag,
because a result that isn't signed off isn't a result, and taking it back is
deleting the row. **A signed-off seed reads what the watches said at the
moment it was signed off**, not what they say now — so a phone that was
offline all afternoon can push whenever it reconnects and nothing moves.
Undoing a sign-off drops straight through to the live watches, which is
exactly when you'd want a late one to count.

**`laneTime()` (`app/lib/timing.ts`) is the one place that decides which time
a seed has**, asking three tiers in order and never mixing them:

1. **The administrator's own reading** — a ruling, and it stands.
2. **The timers, by hand-timing rules** — three take the middle one, two are
   averaged, one stands alone.
3. **The coaches, averaged** — a fallback for a seed the timing table missed;
   coaches time their own swimmers from a worse, interested position, so they
   answer only when nothing better did.

Mixing tiers is the thing to avoid — averaging a coach's watch in with the
timers' would let the side of the pool quietly move an official time. The
control desk shows which tier answered and strikes through the chips that
were outranked: everything is kept, and what counted is visible.

**Every seed's time is a text box, always** — reading the current value and
overwriting it are the same action. Typing over it files the administrator's
own watch, which then wins; clearing it withdraws that watch and the seed
falls back to the timers. An unchanged box writes nothing, so tabbing through
a heat to read times doesn't file twenty rulings.

**A running stopwatch draws its own chip**, ticking on a one-second beat via
`requestAnimationFrame` (never `setInterval`, which throttles when a screen
dims), and holds a `navigator.wakeLock` while it runs. It needs the one
absolute time in the app: a phone's clock is trusted everywhere else only to
order its own actions, but a *running* stopwatch measures a phone's start
against the *desk's* now, so the timer endpoint translates the phone's
timestamps onto the server's on the way in.

**A time is a time however it reached the meet** — off a volunteer's phone, a
coach's multi-lane stopwatch, typed in from a handheld, typed at the desk —
all stored as a watch and weighed the same way. `timerId` is whoever
submitted it (a device id for a volunteer with no account, a user id for
anyone signed in); the server fills it from the session rather than trusting
the client. **`role` is recorded on the watch, not re-derived** — it says what
the submitter was to *this meet at that moment* (timer, coach, admin), because
looking it up later would let someone promoted to admin in March retroactively
turn a January watch into an official reading.

**Device state never reaches the server.** A stopwatch is a fact about the
phone holding it; where a device has gotten to in the running order is device
state too. The one exception: the timer workspace's own position is the
**URL**, not a device value (`/meets/:meetId/timer/:event/:heat/:lane` — the
same shape as the endpoint it posts to), so changing heats is a link, going
back is the back button, and a reloaded phone comes back exactly where it was.
*Who* the phone is stays out of the URL — it's a cookie set server-side when
the QR code is scanned, because a URL segment is only ever what the sender
typed.

**A timer's outbox is cookies; everyone else's is localStorage** — see
Architecture below.

---

## Architecture

**D1 is the durable, cross-meet source of truth** for everything decided
before race day and needed outside any one meet: `teams`, `seasons`,
`athletes`, `enrollments`, accounts/sessions, meet grants, and a meet's own
`meets`/`events` rows (the programme, lineup, settings).

**A meet's live, multi-writer race-day state lives in its own Durable
Object** — `env.MEET_DO.getByName(meetId)`, one instance per meet
(`app/lib/meet-do.server.ts`). It owns `seeds`, `watches`, `results` and
`entries` for the duration of the meet: hydrated from D1 the first time
anything touches the meet, checkpointed back to D1 every five minutes and on
meet close. The DO processes one request at a time by construction, which is
what actually removes the need to reconcile concurrent writes — the row-level
keying above is what makes each write unambiguous, not a lock the app has to
take. Every write to these four tables goes straight to the DO, never to D1
directly; a screen's loader reads meet setup from D1 and the live tables from
the DO's `getSnapshot()` in the same request (`withLiveTables`, in
`app/types/meet.ts`).

**Changes push over a WebSocket instead of being polled for.**
`GET /api/meets/:meetId/live` upgrades to a socket forwarded into the meet's
DO; the DO broadcasts every accepted write to every connected client.
`useMeetLive` (`app/hooks/use-meet-live.ts`) keeps a live snapshot for a
screen that wants one (admin, splits, entries, results, event-detail),
folding each incoming message over the cached snapshot with the same
`applyWrite` reducer the outbox uses for its own optimistic overlay — one
reducer, two callers. `useMeetChanges` is the lighter version for a screen
(the timer) that just wants to know *when* to re-fetch its own purpose-built
read. The socket uses the Workers hibernation API, so an idle connection
between heats costs nothing.

**Auth happens once, before the DO ever sees the request.** The Worker's
loader/action resolves the session (`access.server.ts`) or the timer's grant
token (`grants.server.ts`) and forwards an already-resolved role — the DO
never parses a cookie itself.

**Two write queues exist on purpose, and shouldn't be merged.** They solve
different problems:

- **`outbox.ts` + `pending.ts`** — a localStorage queue of typed `Write`s
  (`app/lib/writes.ts`), used by admin/coach screens, flushed in order to
  `POST /api/meets/:meetId/writes` (`api.meet.writes.ts`), which forwards
  each one to the meet's DO. `applyPending` overlays the queue on top of
  loader/live data so a tap shows instantly.
- **`timer-queue.ts` + `timer-messages.ts`** — a *cookie*-based queue for the
  timer workspace, deliberately not localStorage: a timer's phone may be a
  parent's personal phone in a locked-down or private-browsing webview that
  refuses site storage outright. Each cookie is named for the action and
  pathed to the lane's own URL, so the browser does the addressing,
  de-duplication (submitting twice overwrites) and delivery (it attaches
  whatever's outstanding to the next request to that URL) for free.
  `POST /api/meets/:meetId/timer/:event/:heat/:lane` (`api.timer.lane.ts`)
  reads the cookies and forwards to the DO the same way.

**A failure that can't be fixed by waiting is not retried.** Only network
errors, 408, 429 and 5xx back off and retry; a 400 or 403 is dropped and
reported, so one write the server will never accept can't sit in front of
the whole queue.

**The session travels in two carriers.** A `fetch` from our own code (the
outbox, the timer's phone) sends an `Authorization: Bearer` header. A
*navigation* sends nothing of the sort, and loaders run on navigations, so
there's also an `HttpOnly; SameSite=Lax` cookie — which rides top-level
navigations and not cross-site posts, the CSRF defence.

**Permissions are computed in the loader**, from the same `access.ts`
predicates the write endpoints re-check, so a button and its endpoint can't
disagree about who may press it.

**Server-only code stays out of components.** A `.server.ts` module imported
by anything but a `loader`/`action` fails the build; logic both sides need
goes in the paired pure module (`access.ts` beside `access.server.ts`,
`public.ts` beside `public.server.ts`).

**Two fields are private: birth dates and contact details.** `public.ts`
builds a public view by naming which fields *may* travel, not by deleting the
ones that mustn't — so a field added to a type later is private by default.

```
app/lib/schema.server.ts   D1 tables: teams, seasons, athletes, enrollments,
                           meets, events, and the base shape of entries/
                           seeds/watches/results (mirrored into the DO)
app/lib/meet-do.server.ts  the per-meet Durable Object: live seeds, watches,
                           results, entries; hydration, checkpointing,
                           WebSocket broadcast
app/lib/meet-live.ts       client-side WS connection + snapshot cache
app/hooks/use-meet-live.ts subscribe a screen to the live snapshot
app/hooks/use-meet-changes.ts "something changed" only, for the timer
app/lib/meets.server.ts    meet setup reads/writes against D1
app/lib/teams.server.ts    teams, seasons, enrollments, roster
app/lib/athletes.server.ts people, and the account link
app/lib/access.ts          who may do what — pure predicates
app/lib/access.server.ts   who's asking, from the database
app/lib/timing.ts          watches → proposed time; results; closing (pure)
app/lib/heats.ts           seeding and reseeding (pure)
app/lib/events.ts          lineups and entry limits (pure)
app/lib/public.ts          what anyone may see, and the redaction (pure)
app/lib/public.server.ts   the browse/loader queries
app/lib/writes.ts          the `Write` union — the one wire vocabulary shared
                           by outbox, `applyPending`, and both write endpoints
app/lib/outbox.ts          localStorage write queue (admin/coach)
app/lib/pending.ts         applyWrite/applyPending — the shared overlay reducer
app/lib/timer-queue.ts     cookie write queue (timer)
app/lib/timer-messages.ts  encode/decode for the timer cookie queue
```

---

## Screens

The bottom bar changes with where you are: **Teams / Meets / Athletes** at the
top level; open a meet and it becomes that meet's own modes. The header is
title · view options · status · profile.

| Route | What's there |
| --- | --- |
| `/meets`, `/meets/:id` | Schedule; a meet's own page — setup, lineup, timing QR code, export, delete |
| `/meets/:id/:eventId` | Public, read-only: one event's entries, seeds and current results |
| `/meets/:id/entries` | The registration grid — roster down the side, races across the top |
| `/meets/:id/admin`, `/meets/:id/admin/:event/:heat` | **Control**: the desk, one heat's lane matrix, WS-connected |
| `/meets/:id/splits`, `/meets/:id/splits/:event/:heat` | **Stopwatch**: the multi-lane deck view for a coach |
| `/meets/:id/results`, `/meets/:id/results/:view` | Ranked by event / by swimmer / team scores |
| `/teams`, `/teams/:id` | Every team; one team's roster, seasons, meets, coaches, CSV import/export |
| `/profile` | Account, sign-in methods, this device's display preferences |
| `/athletes`, `/users/:id` | Browsing — open to anyone, no account |
| `/meets/:id/timer`, `/meets/:id/timer/:event/:heat/:lane` | The volunteer's lane picker and stopwatch, reached by QR code, no account |

**Timers** get a QR code taped to the timing table. Holding it is the whole
credential, kept small three ways: a grant is scoped to one meet, it can only
write times/seats/new swimmers, and it stops working the day after the meet.
`/t/:token` has no component — it checks the grant, sets an `HttpOnly` cookie,
and redirects to `/meets/:id/timer`, so timing needs no script to start.

**Diving** is display-only: it holds its place in the running order so divers
appear on the grid, and carries no times.

### API endpoints

Screens are served by their own loaders straight off D1/the DO — there's no
read API mirroring the UI. What's genuinely addressable from somewhere else:

| | |
| --- | --- |
| `GET /api/teams`, `GET /api/users` | Search-as-you-type for the team/person pickers |
| `POST /api/meets/:id/writes` | One `Write` off the outbox, forwarded to the meet's DO |
| `POST /api/meets/:id/timer/:event/:heat/:lane` | One lane, one timer — body-less, cookies are the payload |
| `GET /api/meets/:id/live` | WebSocket upgrade onto the meet's DO broadcast |

Signing in has no endpoint — it's the sign-in screen's own action, ending in a
redirect carrying the session cookie.

### Who may do what

**Two lists, and being on one is the whole of it.** `team_coaches` says who
coaches a team; `meet_admins` says who runs a meet — separate because a meet
belongs to no team (often its administrator is the host's coach, sometimes a
referee who coaches nobody). Whoever creates the thing is on it; anyone on it
can add anyone else; neither list can go down to nobody. A team can start
empty (unclaimed), because every school typed in as an opponent is a team
nobody has signed in to yet — that's the only time somebody can add
themselves.

| | Meet admin | Coach of a racing team | Linked athlete |
| --- | :---: | :---: | :---: |
| Meet details, lineup, seeding | ✓ | | |
| Results: DQ, typed times, sign-off | ✓ | | |
| Watches and seats | ✓ | ✓ | |
| Entries | ✓ | their own team's | themselves, if the meet allows |

Watches and results sit on opposite sides deliberately: a watch is evidence
and an extra one never overwrites anybody, so every coach keeps their
stopwatch; a result is a decision, and with two schools in the water it isn't
one school's to make.

---

## Running it

```sh
npm install
npm run dev          # http://localhost:5173/
npm run typecheck
npm test
npm run build
```

`wrangler dev` creates a local D1 (and the DO's local SQLite storage)
automatically, and `ensureSchema()` creates any missing tables on first use —
a fresh database needs no migration step. `.dev.vars` sets
`AUTH_DEV_CODES=1`, which hands the sign-in code straight back to the browser
so you can sign in with no email/SMS provider configured. It's gitignored and
must never be set on a deployed worker.

### Deploying

1. `npx wrangler d1 create swim-starts`, then paste the returned id into
   `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.
2. Codes have to reach people somehow — a channel with nothing configured logs
   the code on the worker instead of sending it, and says so on screen:
   ```sh
   npx wrangler secret put RESEND_API_KEY     # email
   npx wrangler secret put AUTH_FROM_EMAIL    # e.g. Swim Starts <meets@swimstarts.com>
   npx wrangler secret put TWILIO_ACCOUNT_SID # text messages
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM        # the sending number, in E.164
   ```
3. `npm run deploy`
4. Sign in and start a team, or take on an unclaimed one — the first person to
   ask for it becomes its coach.

### Home screen

Installed to an iOS home screen it runs full-screen with no browser chrome.
`npm run icons` regenerates `public/` from the source art.

---

## Tests

`npm test` — suites under `tests/*.test.ts`, run directly with
`node --experimental-strip-types`, no framework. They pin the properties that
matter rather than the implementation: the hand-timing rules, that a seed is
the only answer to who's in a lane, that a late watch can't move a signed-off
result and that undoing the sign-off lets it count, that reseeding refuses
once an event has times and reuses heat numbers in place, and that a birth
date cannot reach a public response.

**Tests and types have never been sufficient here.** The bugs that mattered
were found by loading the thing in a browser or curling the endpoint. Run it.

---

## Things worth knowing before changing them

- **The lineup order is a column** (`events.position`), so reordering is an
  update rather than a rewrite of a list.
- **Reseeding refuses once anything is recorded against an event**, and
  reuses the existing seeds' ids in place. A fresh id orphans every watch and
  result pointing at the old one.
- **Deletes are real deletes.** No tombstones — nothing else holds a copy
  that could put the row back.
- **Enrollment ids are derived** from season and athlete, so re-importing a
  roster updates rows instead of minting new people.
- **A write's effect in `pending.ts` must match what the DO does with it.**
  That pairing is the one thing to be careful about in that file — and in
  `meet-do.server.ts`'s RPC methods, which have to agree with both.
- **The DO checkpoints to D1 every five minutes and at meet close**, not on
  every write — a screen reading the *live* tables always goes through the
  DO (`getSnapshot()`), never a plain D1 read, or it'll show stale state.

See `TODOS.md` for what's next.

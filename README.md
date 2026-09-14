# Meet Runner

An app for running a high-school swim meet from a pool deck: rosters that carry
across seasons, a schedule of meets, an entries grid, and the timing itself —
volunteers with phones behind each lane, a coach with a multi-lane stopwatch,
and an administrator at a table deciding what stands.

The shape of the problem is the paper system it replaces. Two or three timers
stand behind each lane with stopwatches. They ask who's in the lane, take a
time, and write the team, the name and the time on a sheet. A runner collects
the sheets and hands them to an administrator, who types them into a
spreadsheet and eventually scores the meet. This app crowd-sources that data
entry and pre-fills it from each team's entries. **Where the app disagrees with
the paper, the paper is usually right.**

---

## The model

Three things, and only one of them owns anything.

**Athletes** are people — global and durable. A swimmer is one record whether
they swim for a school, a club, or both, so fixing a spelling in March fixes
January's results too. Nobody is ever deleted, because results reference people
by id forever.

**A team** owns its seasons and says, through *enrollments*, who swam for it and
when. It does not hold its athletes. That is what lets two schools racing the
same swimmer point at one person rather than keeping a copy each, and what keeps
a visiting swimmer off the home roster. Taking someone off the roster ends their
enrollment; the person stays.

**A meet** is one day's racing between one or more teams, and belongs to none of
them. It references teams by id, so a dual meet is a single shared thing both
schools open — rather than two half-copies where the entries land on one and the
times on the other.

A team can exist without an owner. Setting up a meet against a school that has
never used the app mints an *unclaimed* team; a coach from there claims it
later, and the meets it already appears in are unaffected.

### Running a meet: four rows

| Row | Key | Written by | Contention |
| --- | --- | --- | --- |
| `heat` | `id` | admin | none — the running order is the admin's |
| `seat` | `heat_id, lane` | admin **or** timer | last write wins |
| `watch` | `heat_id, lane, timer_id` | anyone racing | none — one row per person |
| `call` | `heat_id, lane` | admin | last write wins |

**A seat is the only answer to who is in a lane.** The coach seeding an event,
the admin correcting the desk, and the timer fixing a name behind the blocks all
write the same row, and the last one wins — because it is one person deciding
one thing. There is no second opinion riding on a watch, no vote between claims,
and no server-side rule reconciling the two. On paper, the name the timer writes
*is* the fact.

**A watch is evidence and is never overwritten.** One row per timer per lane.
Several on a lane produce a *proposed* time by the hand-timing rules: one stands
alone, two are averaged, three or more take the middle — which is the point of a
third watch, since it outvotes a slow thumb rather than dragging the average
toward it. Times truncate to hundredths, never round up: a time you didn't swim
is not a time.

**A call is the decision, and there is exactly one per lane.** Status, the
official's own reading of the clock, and whether it's signed off — three fields
of one decision, folded onto whatever is already there. Marking a DQ keeps a
typed time; typing a time keeps a DQ.

- `time_ms` absent means "whatever the watches say". Set, it is the official's
  own reading and outranks them.
- **A signed-off lane reads what the watches said at the moment it was signed
  off**, not what they say now. This is what makes a late watch harmless: a
  phone that was offline all afternoon can push whenever it reconnects and
  nothing moves. The watch is still recorded and timestamped, so the call can be
  reopened deliberately — and taking the sign-off back drops straight through to
  the live watches, which is exactly when you'd want the late one to count.

**Nothing about a clock is stored in the meet.** A stopwatch is a fact about the
device holding it; three timers behind one lane each start their own on the
strobe. Where a device has got to in the running order is device state too. Both
live in `storage.ts` / component state and never reach the server.

Everything else is derived and never stored: the proposed time, which lanes
swam, and whether a heat or an event is closed. A heat is closed once every lane
that swam has been signed off; an event once all its heats are. Derived means
"closed" can never disagree with the calls underneath it.

---

## Architecture

**The server is the source of truth.** D1 holds real tables; screens read
through React Router loaders and write through small JSON endpoints. There is no
client store, no IndexedDB, and no sync engine.

```
app/lib/schema.server.ts   the tables
app/lib/meets.server.ts    meets, events, entries, heats, seats, watches, calls
app/lib/teams.server.ts    teams, seasons, enrollments, roster
app/lib/athletes.server.ts people, and the account link
app/lib/access.ts          what somebody may do — pure predicates
app/lib/access.server.ts   who they are, from the database
app/lib/timing.ts          watches → proposed time; calls; closing (pure)
app/lib/heats.ts           seeding and reseeding (pure)
app/lib/events.ts          lineups and entry limits (pure)
app/lib/public.ts          what anyone may see, and the redaction (pure)
app/lib/public.server.ts   the browse queries
app/lib/outbox.ts          the write queue
app/lib/pending.ts         the optimistic overlay (pure)
```

### Patterns

**Rows several people write at once are keyed so they can't collide.** Six
timers seating their own lane write six different rows; three timers on one lane
write three different rows; two coaches entering their own swimmers write
different rows. Concurrency is a property of the keys, not something the app
reconciles afterwards.

**Permissions are computed in the loader, beside the rows they guard.** A screen
gets its data and its `MeetAccess` from the same request, so the button and the
endpoint cannot disagree about who may press it. The predicates in `access.ts`
are shared by both sides. Every write endpoint re-checks; the UI check only
decides what to draw.

**`meet_id` is denormalised** onto events, entries, heats, seats, watches and
calls. It's derivable by joining, and it's there because every screen under a
meet asks "everything for this meet", which D1 answers fastest as a handful of
indexed single-table reads. `meetDetail()` is that read.

**Writes go through the outbox.** A typed union of small writes, persisted to
localStorage and drained in order, one at a time — a seat and the watch that
follows it describe the same lane, so letting the second overtake the first would
put a time against whoever used to be there. `applyPending()` folds the queue
over loader data as a pure function, so a tap shows instantly and keeps working
with no signal without there being a second copy of the meet to drift.

> **A failure that can't be fixed by waiting is not retried.** Only network
> errors, 408, 429 and 5xx back off; a 400 or 403 is dropped and reported. An
> earlier engine retried everything, so one write the server would never accept
> sat in front of the whole queue forever behind a chip reading "Retrying…".

**The session travels in two carriers.** A `fetch` from our own code sends an
`Authorization: Bearer` header — that's the outbox, the timer's phone, and any
script. A *navigation* sends nothing of the sort, and loaders run on
navigations, so there is also an `HttpOnly; SameSite=Lax` cookie. `SameSite=Lax`
rides top-level navigations and not cross-site posts, which is the CSRF defence.

**Two things are private, and only two:** birth dates and contact details.
`public.ts` builds a public athlete by *naming the fields that may travel*
rather than deleting the ones that mustn't — so a field added to `Athlete` later
is private until somebody decides otherwise. Keep it that way.

**Server-only code stays out of components.** A `.server.ts` module imported by
anything other than a `loader`/`action` fails the build. When both sides need a
rule, it goes in the pure half — `access.ts` beside `access.server.ts`,
`public.ts` beside `public.server.ts`.

---

## Screens

The bottom bar changes with where you are: **Team / Meets / Browse / Settings**
at the top level; open a meet and it becomes that meet's modes with a way back
out, so Run stays one thumb tap away while a heat is in the water. The header is
title · view options · status · profile.

| | |
| --- | --- |
| `/team` | The roster for the current season: CSV import, add by hand, tap through to a swimmer |
| `/meets` | The schedule, and creating one |
| `/meets/:id` | Details, the running order, the timing QR code, export, delete |
| `/meets/:id/entries` | The registration grid — roster down the side, races across the top |
| `/meets/:id/run` | **Control** (the desk) and **Stopwatch** (the deck), switchable for an admin |
| `/meets/:id/results` | Ranked by event across all heats |
| `/teams`, `/athletes`, `/users/:id` | Browsing — open to anyone, no account |
| `/timer` | The volunteer's stopwatch, reached by QR code, no account |

**The control desk** shows every watch on a lane as its own chip, because a
single slow thumb is obvious side by side and invisible once averaged — and
because the median only means anything if you can see what it chose between.
DQ, no-show and sign-off live here rather than on the deck: a call is a decision,
made where you can see the evidence.

**The deck stopwatch** holds its own clock. START clears *this device's* watches
for the heat and nobody else's; so does Reset, and neither touches a call. A
device may discard its own evidence; discarding somebody else's is a decision.

**Timers** get a QR code taped to the timing table. Holding it is the whole
credential — that is deliberate, and the blast radius is kept small three ways: a
grant is scoped to one meet, it can only write times, seats and new swimmers,
and it stops working the day after the meet. Issuing a new code retires the old
one, which is also how you revoke.

**Diving** is display-only. It holds its place in the running order so divers see
it on the grid, and carries no times.

---

## API

UI and API mirror each other, with one query and one projection behind both.

| | |
| --- | --- |
| `GET /api/meets`, `/api/meets/:id` | Every meet; one meet with its results |
| `GET /api/teams`, `/api/teams/:id` | Every team; one team's seasons and roster |
| `POST /api/teams` | Mint an unclaimed opponent (signed in) |
| `GET /api/athletes`, `/api/athletes/:id` | People, and one person's history |
| `GET /api/users/:id` | Somebody's own dashboard — only ever their own |
| `POST`/`DELETE /api/meets/:id/entries` | Enter or scratch one swimmer |
| `POST`/`DELETE /api/meets/:id/seats` | Who is in a lane |
| `POST`/`DELETE /api/meets/:id/watches` | Times, and dropping your own |
| `POST`/`DELETE /api/meets/:id/calls` | Deciding a lane |
| `GET`/`POST`/`DELETE /api/meets/:id/admins` | Who runs a meet |
| `POST /api/athletes/:id/link` | Say which account a swimmer is. Coaches only |
| `/api/auth/*`, `/api/memberships`, `/api/invites` | Accounts and membership |
| `/api/timer/grant`, `/timer/meet`, `/timer/watch` | The QR-code timing path |

### Who may do what

Roles are team-scoped except one. **Running a meet is scoped to the meet**,
because a meet belongs to no team — often it's the host's coach, sometimes a
referee who coaches nobody. Whoever creates a meet administrates it.

| | Meet admin | Coach of a racing team | Linked athlete |
| --- | :-: | :-: | :-: |
| Meet details, lineup, seeding | ✓ | | |
| Calls: DQ, typed times, sign-off | ✓ | | |
| Watches and seats | ✓ | ✓ | |
| Entries | ✓ | their own team's | themselves, if the meet allows |

Watches and calls sit on opposite sides deliberately: a watch is evidence and an
extra one never overwrites anybody, so every coach keeps their stopwatch. A call
is a decision, and with two schools in the water it isn't one school's to make.

---

## Running it

```sh
npm install
npm run dev          # http://localhost:5173/projects/meet-runner/
npm run typecheck
npm test
npm run build
```

`wrangler dev` creates a local D1 automatically, and `ensureSchema()` creates any
missing tables on first use — a fresh database needs no migration step.
`.dev.vars` sets `AUTH_DEV_CODES=1`, which hands the login code straight back to
the browser so you can sign in with no email or SMS provider. It is gitignored,
and must never be set on a deployed worker.

### Deploying

1. Create the database and paste the returned id into `wrangler.jsonc` in place
   of `REPLACE_WITH_D1_DATABASE_ID`:

   ```sh
   npx wrangler d1 create meet-runner
   ```

2. Codes have to reach people somehow. A channel with nothing configured logs
   the code on the worker instead of sending it, and says so on screen rather
   than failing silently.

   ```sh
   npx wrangler secret put RESEND_API_KEY     # email
   npx wrangler secret put AUTH_FROM_EMAIL    # e.g. Meet Runner <meets@example.com>
   npx wrangler secret put TWILIO_ACCOUNT_SID # text messages
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM        # the sending number, in E.164
   ```

3. `npm run deploy`

4. Sign in and claim the team — the first person to ask for an unclaimed team
   becomes its head coach.

### Home screen

Installed to an iOS home screen it runs full-screen with no browser chrome.
`npm run icons` regenerates `public/` from the source art.

---

## Tests

`npm test` — eight suites under `node --experimental-strip-types`, no framework.
They pin the properties that matter rather than the implementation: the
hand-timing rules, that a seat is the only answer to who's in a lane, that a
late watch can't move a signed-off result and that undoing the sign-off lets it
count, that a call's three fields don't erase each other, that reseeding refuses
once an event has times and reuses heat ids in place, and that a birth date
cannot reach a public response.

**Tests and types have never been sufficient here.** Across every rewrite, the
bugs that mattered were found by loading the thing in a browser or curling the
endpoint: raw SQL naming a column that no longer existed, public pages behind a
sign-in gate, a session that loaders couldn't see because it only travelled as a
`fetch` header, an athlete able to rename the whole team. Run it.

---

## Things worth knowing before changing them

- **The lineup order is a column** (`events.position`), so reordering is an
  update rather than a rewrite of a list.
- **Reseeding refuses once anything is recorded against an event**, and reuses
  the existing heats' ids in place. A fresh id orphans every seat, watch and
  call pointing at the old heat — rows that stay in the meet, count towards
  things, and render nowhere.
- **Deletes are real deletes.** No tombstones: nothing else holds a copy that
  could put the row back.
- **Enrollment ids are derived** from season and athlete, so re-importing a
  roster updates rows instead of minting new people. This is what stops the
  "9 entered, three ticks" failure the old model had.
- **`nextYear` and `isGraduating` only understand numeric grades.** A CSV
  contains whatever a school types, and a ladder that half-works silently
  mislabels every row it doesn't recognise.
- **A write's effect in `pending.ts` must match what the server does with it.**
  That pairing is the only thing to be careful about in that file.

See `TODOS.md` for what's next.

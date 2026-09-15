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

**A watch is evidence and is never overwritten.** One row per submitter per
lane. Times truncate to hundredths, never round up: a time you didn't swim is
not a time.

**`laneTime()` is the one place that decides which time a lane has.** Watches
on a lane are not all the same kind of evidence, so it asks three tiers in
order and never mixes them:

1. **The administrator's own reading.** Whoever runs the meet has looked at the
   lane and said what it was. That is a ruling and it stands.
2. **The timers, by the hand-timing rules.** Three take the middle one, two are
   averaged, one stands alone — which is the point of a third watch, since the
   median outvotes a slow thumb rather than letting it drag an average.
3. **The coaches, averaged.** A fallback for a lane the timing table missed.
   Coaches time their own swimmers from the side, which is a worse position and
   an interested one, so they answer only when nothing better did.

Mixing them is the thing to avoid: averaging a coach's watch in with the timers'
would let the side of the pool quietly move an official time, and a median
across all of them would do the same less visibly. The control desk shows which
tier answered, and strikes through the chips that were outranked — everything is
kept, and what counted is visible. **Signing off copies exactly that number onto
the call**, so the accepted time is the one that was on screen.

**Every lane's time is a text box, always.** The desk's job on each row is the
same — read the time, change it if it's wrong — and an Edit button made the
second of those a mode to enter first. The box holds `laneTime`'s answer; typing
over it files the administrator's own watch, which then wins, so the number
comes straight back. Clearing it withdraws that watch and the lane falls back to
the timers, which is the way out of a time typed by mistake. An unchanged box
writes nothing, because tabbing through a heat to read times must not file
twenty rulings.

**A stopwatch that is still running draws its own chip**, ticking on a one-second
beat, next to the times that have already arrived. The desk can see the race it
is watching, so the number is not the point — what it answers is which lanes are
genuinely being timed, and, once a heat is long over, which timer is still
holding a clock they forgot to stop. That last one is invisible otherwise: the
lane simply never completes and nobody knows why.

It needs the one absolute time in the app. Everywhere else a phone's clock is
trusted only to order that phone's own actions, because a time is a difference
between two readings of one clock and is right however wrong the clock is. A
running stopwatch measures a phone's start against the *desk's* now, so
`/api/meets/…/timers/…` translates the phone's timestamps onto the server's on
the way in: the message says when the thumb landed and arrives at a known
moment, and `start` is flushed instantly, so the difference is the phone's error
plus a network hop. A phone ninety seconds fast lands within one.

**The box's colour is the lane's timing, which its number cannot say.** Grey and
dashed is nobody covering the lane; amber is watches running or some in; green is
the timing table done. The middle one is why it exists: a lane with nothing on it
and a lane whose timers are all still holding their clocks show the same empty
box and want opposite responses — send somebody, or leave it alone. `start` is
sent on its own the instant a thumb lands precisely so `laneProgress()` can tell
them apart, which is what `timer_activity` is for.

**A time is a time however it reached the meet.** Off a volunteer's phone, off a
coach's multi-lane stopwatch, typed in from a handheld, typed in at the desk —
all of it is a watch, stored the same way and weighed the same way. `timer_id`
is whoever submitted it: a device id for a volunteer with no account, a *user*
id for anybody signed in, so a coach keeps one watch per lane whichever iPad
they pick up. `user_id` is set alongside it for a signed-in person, which is
what tells a person from a phone and what a screen joins on to show a name. The
server fills both from the session rather than believing the client — evidence
with the wrong name on it is worse than none.

**`role` is recorded, not re-derived.** A watch says what its submitter was to
this meet *at the moment they took it* — timer, coach or administrator. It can't
come off the watch alone, and it must not be looked up later: a coach made an
administrator in March would otherwise turn the watch they held in January into
the official's own reading. Same principle as a sign-off snapshotting the
watches — a record of a decision has to say what was true when it was made.

**How a time arrived is `started_at` and `stopped_at`, not a field about them.**
Both present means a stopwatch in this app ran the race; neither means somebody
typed a number in. There was a `source` column saying "stopwatch" or "typed",
and every caller set it to exactly what those two already said — a field that
restates another is a field that can contradict it, and one of them did: the
timing endpoint briefly marked properly-timed lanes as typed, because `start`
arrives in its own request and had been cleared by the time `submit` landed.
`fromStopwatch()` reads it off the timestamps instead.

The desk's own reading used to be written onto the *call*, where it silently
outranked every watch on the lane. Two problems with that: the same act of
reading a clock was stored two different ways depending on who did it, and an
override left nothing to say what it overrode. The desk's power over a time is
now discarding the reading it doesn't believe — which leaves the ones it did on
the record. Dropping somebody else's watch needs `mayDecide`; dropping your own
never did and still doesn't.

**A call is the decision, and there is exactly one per lane.** Status, the
official's own reading of the clock, and whether it's signed off — three fields
of one decision, folded onto whatever is already there. Marking a DQ keeps a
typed time; typing a time keeps a DQ.

- `time_ms` absent means "whatever the watches say". Set, it outranks them —
  but nothing writes one any more; it survives for rows an older build made.
- **A signed-off lane reads what the watches said at the moment it was signed
  off**, not what they say now. This is what makes a late watch harmless: a
  phone that was offline all afternoon can push whenever it reconnects and
  nothing moves. The watch is still recorded and timestamped, so the call can be
  reopened deliberately — and taking the sign-off back drops straight through to
  the live watches, which is exactly when you'd want the late one to count.

A timer sends four things, and only one of them is a result. `seat` says who is
in the lane, `start` and `stop` say the built-in stopwatch was used and when —
which is how the desk sees five lanes armed and a sixth not, *before* the gun —
and `submit` is the time. `start`/`stop` land in `timer_activity`, which is
neither evidence nor decision but telemetry; the watch reads it to know whether
a time came off the phone or was typed in from a handheld, so the phone never
has to assert that. It is read from the table rather than from the request,
because `start` goes up on its own and is long since cleared by the time
`submit` follows.

**Nothing about a clock is stored in the meet.** A stopwatch is a fact about the
device holding it; three timers behind one lane each start their own on the
strobe. Where a device has got to in the running order is device state too. Both
live in `storage.ts` / component state and never reach the server.

**Device state that must survive is a cookie; the rest is guarded
localStorage.** Not a preference — every browser has the storage API and not
every browser lets you use it, and a timer's phone is a stranger's phone opened
from a camera app. So the small, bounded facts that timing depends on — the
grant, which lane, where in the running order, and *who this device is* — are
cookies, about a hundred bytes in total. Everything else goes through
`local.ts`, the only module that names `localStorage`, where a refusal reads as
"nothing stored" rather than throwing out of whichever line happened to ask.
Those lines were in the root providers, so a phone that refused storage didn't
lose a preference, it lost the whole screen.

The device's timer id is the one whose loss corrupts rather than inconveniences:
watches are keyed by it, so a device that forgets it files a *second* watch on a
lane it already timed and the proposed time moves. It falls back cookie →
legacy localStorage → a value held in the module, so it is stable for as long as
the tab is open even when nothing can be persisted at all.

**Where a timer is standing is the URL, not the device.** Every timing page is
`/meets/{meetId}/timers/{timerId}/{event}/{heat}/{lane}` — the same shape as the
endpoint it posts to. So changing heats is a link, going back a heat is the back
button, a reloaded phone comes back exactly where it was having remembered
nothing, and a volunteer can be read their position down the pool when something
has gone wrong. The lane, the heat, the event and the meet were four cookies
before this; they are the address now.

The device's id is minted by the server when the code is scanned, so it is in
that address from the first screen — and re-used when the phone already has one,
because a volunteer scanning again after lunch must come back as the *same*
timer. Watches are keyed by it, and several on a lane are averaged, so a device
that forgets doesn't just duplicate a time, it moves the one the desk reads.

The one thing left on the device is how far this timer has *been*: the URL says
where they are, not the furthest they have got, and going back into a heat whose
sheet has already reached the desk is what that stops. One number, in a cookie
pathed to this meet and this device, so a different meet starts clean without
anything having to notice.

**A timer's outbox is cookies; everybody else's is localStorage.** They face
different problems. A coach signs in on their own iPad and can be expected to
have working storage and plenty to sync. A timer's phone belongs to a parent who
volunteered ten minutes ago, opened from a camera app into whatever browser it
chose — and has one lane's worth of data. So timing queues in cookies, which
such a browser still keeps, and the two paths are allowed to differ.

Each message is a cookie **named for the action** and **pathed to the lane**:

```
submit=1789413369235,30000
Path=/…/api/meets/{meetId}/timers/{timerId}/{event}/{heat}/{lane}
```

which makes three things free. *Addressing*: nothing in the value repeats what
the path says. *De-duplication*: a cookie is identified by name, domain and
path, so submitting twice on one lane overwrites — the browser keys it exactly
as the server writes it. *Delivery*: the browser attaches whatever a lane still
owes to the next request to that lane's URL, so `flushQueue` walks a list of
addresses rather than a list of payloads, and the server clears what it consumed
on the way out.

It also makes retrying free. If a write succeeds and the *response* is lost, the
cookies survive, the phone tries again, and the second attempt writes what the
first one did — every row is keyed by heat, lane and timer. So the client never
has to work out whether it already sent something.

The catch, and the reason there is still one readable cookie: **`document.cookie`
only returns cookies matching the current page's path**, so the payloads are
invisible to the screen that has to replay them. One index cookie at the app
path names which lanes are outstanding — `event/heat/lane`, nothing more — and
that is the only part the client ever reads back.

Overflow is the one way this loses a time, since a browser handed a cookie over
~4KB drops it silently rather than throwing. So the size is checked before the
write, and a failure turns the header red and says so. The real ceiling is the
per-domain cookie *count* — around 150 — which four actions a lane reaches
before the byte limit does, and long after a timer with thirty unsent lanes
should have been noticed on the deck.

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

**One page per thing, with the editing on it.** A team is `/teams/:id` whether
you coach there or are following a link to look, and the controls appear for
whoever the server says may use them — the same arrangement a meet has. There
used to be a second screen at `/team` showing the one roster a device could
edit, and it drifted from the public one in the way two screens over a single
thing always do: different sort, different fields, different idea of which
season you meant.

Everything about running a team is there too — its name and code, its seasons,
who may join it, the export. That was a Settings tab, which had to guess *which*
team it meant: it took the signed-in coach's first active membership, so a coach
of two schools could configure one of them and had no way to reach the other. On
the team's own page the team is the URL, and the question doesn't arise. What was
left of Settings afterwards was a single display preference, which now sits on
Profile under **Preferences** — labelled as this device's, because that is what
it deliberately is.

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

**Naming an opponent searches before it creates.** A meet references teams by
id, so two rows for one school is the failure the whole model exists to
prevent — and the only way it happens is somebody typing a name that already
exists. So one box answers "who are we swimming?": what's typed searches the
known teams first, ranked so a name *starting* with it beats one merely
containing it, and creating is offered only once nothing matched — demoted to
a quiet link whenever something did. `POST /api/teams` hands back the existing
team on a name clash rather than minting a second, so the server agrees.
`team-search.ts` holds the ordering, pure and tested, because the ordering is
what decides whether somebody finds the row or gives up and makes another.

**Screens under a running meet re-read on a timer.** A loader only re-runs
when *this* device navigates or finishes a write, which is fine everywhere
except on a deck, where three phones are writing times to lanes the control
desk is showing. `useLiveData()` revalidates every 3s — but only while the tab
is visible, only when the previous read has come back, and only when this
device owes the outbox nothing, since the outbox already revalidates the moment
it drains. Revalidation is its own router state, so none of it reaches the
status chip: times appear, and nothing announces that they did. The push
version is a Durable Object per meet, and is not built.

> **A failure that can't be fixed by waiting is not retried.** Only network
> errors, 408, 429 and 5xx back off; a 400 or 403 is dropped and reported. An
> earlier engine retried everything, so one write the server would never accept
> sat in front of the whole queue forever behind a chip reading "Retrying…".

The timer's own credential travels one way only, and it is not this one.

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

The bottom bar changes with where you are: **Teams / Meets / Athletes** at the
top level; open a meet and it becomes that meet's modes with a way back
out, so Run stays one thumb tap away while a heat is in the water. The header is
title · view options · status · profile.

| | |
| --- | --- |

| `/meets` | The schedule, and creating one — including who's racing |
| `/meets/:id` | Details, the running order, the timing QR code, export, delete |
| `/meets/:id/entries` | The registration grid — roster down the side, races across the top |
| `/meets/:id/run` | **Control** (the desk) and **Stopwatch** (the deck), switchable for an admin |
| `/meets/:id/results` | Ranked by event across all heats |
| `/teams`, `/teams/:id` | Every team; one team's roster, seasons, meets — and for a coach of it: CSV import, add by hand, renaming, seasons, invites, export |
| `/profile` | The account: name, ways to sign in, signing out, and this device's display preferences |
| `/athletes`, `/users/:id` | Browsing — open to anyone, no account |
| `/meets/:id/timers/:timerId` | The volunteer picks a lane, reached by QR code, no account |
| `/meets/:id/timers/:timerId/:event/:heat/:lane` | Their stopwatch, addressed like the endpoint behind it |

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

**The scanned token becomes a cookie, on the server, during the redirect.**
`/t/:token` has no component: it checks the grant, sets an `HttpOnly` cookie
scoped to the app's path with the grant's own lifetime, and 302s to `/timer`.
So timing needs no script to start and nothing on the device to persist — which
matters because the phone is a stranger's, opened from a camera app into
whichever browser it felt like using. It also means no code anywhere holds the
token, so nothing on the page can leak it. It used to be kept in localStorage
from an effect, which made the whole timing path depend on script running *and*
on the browser agreeing to store things.

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
| `/api/timer/grant`, `/timer/meet` | The QR-code timing path |
| `POST /api/meets/:id/timers/:timerId/:event/:heat/:lane` | One lane, one timer — body-less; the cookies are the payload |

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

# Meet Runner

A phone/iPad app for managing a high-school swim team and high-school swim meets:
ability to add edit teams and their rosters (which carry across the years), ability to manage schedule of meets/entries, ability to run a meet including individual timer and coach's multi-lane
stopwatch.

Local-first. Everything lives on the device, so the app keeps working on a pool
deck with no signal. It backs itself up to the server in the background as you
go, and catches up on its own once signal returns.

## How it's organised

Three things, and only one of them owns anything.

**Athletes** are people — global and durable. A swimmer is one record whether
they swim for a school, a club, or both, so fixing a spelling in March fixes
January's results too. Nobody is ever deleted, because results reference people
by id forever.

**A team** owns its seasons, and says through *enrollments* who swam for it and
when. It does not hold its athletes. That's what lets two schools racing the
same swimmer point at one person rather than keeping a copy each, and what
keeps a visiting swimmer off the home roster. Taking someone off the roster
ends their enrollment; the person stays.

**A meet** is one day's racing between one or more teams, and belongs to none
of them. It carries `teamIds` referencing real teams, so a dual meet is a
single shared thing both schools open — rather than two half-copies where the
entries land on one and the times on the other.

A team can exist without an owner. Setting up a meet against a school that has
never used the app mints an *unclaimed* team; a coach from there claims it
later, and the meets it already appears in are unaffected.

The bottom bar changes with where you are. At the top level it's **Team /
Meets / Browse / Settings**; open a meet and it becomes that meet's modes with
a way back out, so Run stays one thumb tap away while a heat is in the water.

## Team

The roster: import a CSV, add swimmers by hand, or tap through to a swimmer for
their details and every time they've swum, grouped by event with a best-time
marker and a link to each meet. Archiving is the only way off the roster.

Names are ordered and written per **Settings → Name order**, which applies to
the roster, registration, the lane buttons and the lane picker. It's a
per-device preference rather than a team setting — with teams now shared, a
visiting coach shouldn't change how the host reads its own roster.

## Meets

The season's schedule, newest first, each showing its type and opponent plus a
count of events, entries and recorded times. A new meet can start from the
standard 8-event order rather than an empty lineup. Opening one gives four
modes:

**Setup** — two tabs.

- _Events_: reorder with the arrows, set each event to Open / Girls / Boys, or
  load the standard dual-meet order — 22 events split girls/boys by default, or
  11 "open" ones for an inter-squad meet. **First in each pair** flips the whole
  lineup between girls-first and boys-first in one tap; it reorders the existing
  events rather than rebuilding them, so entries and recorded times survive.
  Relays are just events — see below.
- _Options_: 4, 6, or 8 lanes, and how the stopwatch arranges its buttons —
  a two-column grid, or a single column running low-to-high or high-to-low. The
  list layouts let someone watching from the side map a finish straight onto a
  button without first working out which column it's in; a live preview shows
  the arrangement as you pick. Eight lanes as a list is tall — it fits an iPad
  or an installed phone app, but may scroll slightly in mobile Safari.

**Registration** — the team roster down the side, races across the top, tap a
cell to enter or scratch.

**One column per race, not per event.** A split lineup swims each race twice,
but there's no reason to make you tap through twice as many columns when the
swimmer's gender already says which of the two they belong in — tapping a girl's
cell in "200 Free" enters her in the girls' 200 Free, and a boy's in the boys'.
The header shows the distance, the stroke and both counts (`2/1`); the
underlying event numbers are in its tooltip rather than taking a line. A race
with no version for a swimmer greys out.

**Girls / Boys** toggles in the header filter the roster. They sit inline with
the sync chip so they cost no vertical space, and ride on a search param, so the
grid never has to share state with the chrome. Showing everyone is the default
and there's no "All" button — tapping the active toggle clears it, tapping the
other swaps. With a filter on, the header counts switch to just that gender's.

Rows are sorted and written per **Settings → Name order**: `Last, First` sorts
by surname and writes it that way, `First Last` does the reverse — so the part
you're scanning always comes first. Whichever name isn't sorted on breaks ties,
so siblings never shuffle between renders. Names are always written in full, and
rows carry subtle zebra striping to make a wide row easier to follow across.

Sorting is display-only: the stored roster keeps its import order, so it never
churns the document or the sync.

The whole screen is grid: the name column and the header row stay pinned however
you scroll, and columns divide the window evenly, falling back to sideways
scrolling once there are more races than fit at a tappable width. Counts update
live, including events-per-swimmer in each row. Swimmers who turn up on the day get added under Team — the in-grid
search box and `+ Swimmer` button are hidden behind `SHOW_ROSTER_CONTROLS` in
`app/routes/registration.tsx`, so flip that to `true` to bring them back.

**Run Meet** — one heat on screen at a time.

- A single panel below the lanes — within thumb reach, and a fixed height so the
  lane buttons never shift — holds whichever of three things is current:
  `START` before the heat, the running clock during it, and `Reset` /
  `Next heat` once every lane is in.
- `START` starts every occupied lane at once.
- Each lane becomes its own big `STOP` button showing the swimmer's name; tap it
  as they touch. The lane freezes at its time while the clock keeps running.
  Grid buttons stack their contents; list rows run left to right with the lane
  number in a fixed column down the edge.
- `Reset` re-runs the current heat (clears its times). `Next heat` advances,
  rolling on to the next event after the last heat. Neither is on screen while
  swimmers are still in the water, so a stray tap can't end a live race.
- `Reset` asks first, naming how many times it would erase. `Cancel` takes the
  spot `Reset` was just in, so a double tap lands on the harmless half.
- Tap an **empty lane** to pick who's swimming it. That seats them and enters
  them in the event in one step, for the swimmer who decides while walking up
  behind the blocks. Anyone already seeded elsewhere in the event can be moved
  up from there; anyone who has already swum it can't. `Remove from lane` in the
  lane sheet undoes it, dropping the entry again if they have no time in that
  event. Empty lanes aren't tappable mid-race, so the picker can never cover the
  `STOP` buttons.
- Tap a lane that's already stopped to type a time in, mark a DQ or no-show, or
  clear it — one missed stop button shouldn't cost the whole heat. Times are
  typed as bare digits, no separator needed: the last two are always hundredths,
  so `3045` is 30.45 and `11127` is 1:11.27. A decimal or a colon still works
  and gives the same answer. The sheet shows what it will save as you type.
- The event arrows are locked while a heat is still in the water, so a stray tap
  can't throw away a running race. They unlock once every lane is in.

**Results** shows each event ranked across all its heats, and exports a results
CSV or a full JSON backup.

## Relays

A relay is timed like any other event: one lane, one clock, one time. The app
deliberately doesn't model the four legs. A relay lane is held by a **single
swimmer standing in for the squad** — usually whoever leads off — so register
one swimmer per relay team, or leave the event empty and assign lanes at the
blocks with `+ Add swimmer`.

That keeps seeding, the stopwatch, results, export and swimmer history working
unchanged, at the cost of one simplification worth knowing: the relay time is
credited to that one swimmer, so it shows up under their name in results and on
their swimmer page. Splits and per-leg credit would need a real relay model.

`Free Relay` and `Medley Relay` are strokes like any other, and the standard
dual-meet order now includes them where they actually fall — 200 Medley Relay
opens, 400 Free Relay closes.

## Adding it to a home screen

On the iPhone or iPad, open the site in Safari and pick **Share → Add to Home
Screen**. It launches without the address bar or tabs, which is worth roughly
another heat's worth of rows on the registration grid. Android and desktop
Chrome offer the same thing via the install prompt.

`public/manifest.webmanifest` declares `display: standalone`, and `app/root.tsx`
carries the `apple-*` meta tags plus the touch icon iOS needs — without one it
uses a screenshot of the page as the icon. Icons are generated, not hand-drawn;
see "Regenerating the icons" below.

Two things to know:

- **The installed app has its own storage.** iOS keeps home-screen web apps in a
  separate container from Safari, so a meet you set up in the browser won't be
  in the installed app. Push it to the server first, then pull it down from the
  server list on the first launch.
- **It isn't offline-capable yet.** Once loaded, everything runs locally, but
  the first load of a session still fetches the page from the server. There's no
  service worker, so launching from the home screen with no signal at all will
  fail. Load the app once on the way to the pool and it'll be fine.

### Regenerating the icons

```sh
npm run icons
```

`scripts/make-icons.mjs` writes `public/icon-*.png` directly — Node's `zlib` is
all a PNG encoder actually needs, so there's no image library in the dependency
tree. To change the artwork, edit `waveCoverage` and re-run. Or ignore the
script and drop in real exports at 180, 192, and 512 px, plus a 512 px maskable
version that keeps its content inside the middle 80%.

## How it's put together

React Router 7 (framework mode) on a Cloudflare Worker, Tailwind 4, served under
`/projects/meet-runner/`.

- `app/types/meet.ts` — `Athlete`, `TeamDoc` and `MeetDoc`, all plain JSON (no
  `Map`/`Set`/`Date`) so the same value round-trips through IndexedDB and the
  server unchanged. Both documents hold athlete _ids_ only.
- `app/lib/documents.ts` — defaults and checking, deliberately pure so the
  worker can share them without pulling in browser storage code.
- `app/lib/objects.ts` — decomposing a season into scoped objects and putting
  it back. Pure, and the property the tests pin down is that a round trip gives
  the same season back.
- `app/lib/public.ts` / `public.server.ts` — the browsing half. `public.ts` is
  pure so the redaction can be tested without a database.
- `app/lib/db.ts` — IndexedDB. A season outgrows localStorage (~150KB a meet
  against a ~5MB ceiling, and Safari's failure mode is a thrown quota error
  mid-write, which on a deck means losing times). Athletes live under their own
  key rather than in the team record, and are recovered from an older team
  document on first launch after the upgrade.
- `app/state/app-store.tsx` — context store holding the team, the people and
  every meet in memory. Mutations go through `editTeam`/`editMeet`, which stamp
  `updatedAt`; an effect writes back only the documents whose identity changed,
  so editing one meet doesn't rewrite the season.
- `app/lib/heats.ts` — seeding. Heats are filled so the short heat comes first
  and the last heat is full, and lanes fill from the middle of the pool outward
  (6 lanes: 3, 4, 2, 5, 1, 6).
- `app/hooks/use-stopwatch.ts` — the clock is always `Date.now() - startedAt`,
  never an accumulated counter, so it stays accurate through dropped frames, a
  backgrounded tab, a screen lock, or a reload mid-heat. Also holds a screen
  wake lock while a heat is running.
- `app/lib/sync.server.ts` + `app/routes/api.*.ts` — one `objects` table and
  the endpoints over it.

Times are stored as integer milliseconds and only formatted for display.

### Sync

Documents are what the app thinks in; **objects** are what goes over the wire.
A season decomposes into small records — a team, its seasons, its enrollments,
a meet, its lineup, each entry, each heat, each watch, each ruling — and
recomposes on the other side. That's the whole reason concurrent work is safe:
an athlete added on the laptop and a time recorded on the iPad are different
objects, so they merge instead of one clobbering the other. Only a genuine edit
to the *same* object is a contest, and the loser is told.

Every object carries a **scope**, which is the one thing the server needs to
answer "what changed?":

| Scope | Holds | Pulled by |
| --- | --- | --- |
| `team:{id}` | seasons, enrollments | members of that team |
| `meet:{id}` | lineup, entries, heats, watches, rulings | anyone working that meet |
| `global` | athletes | everyone — people belong to nobody |

Scoping a meet by its own id rather than by an owning team is what lets two
schools work one dual meet: both pull `meet:{id}`, neither owns it, and neither
sees a byte of the other's roster.

`updatedAt` is the editing device's clock and decides who wins a contest for an
object. `server_at` is ours, and is what a cursor pages through — a device with
a wrong clock shouldn't be able to hide a change from everyone else.

**Reading and writing are not the same permission.** Everyone on a team reads
the same set; only a coach writes most of it. A swimmer whose account a coach
has linked to their roster entry may enter and scratch *themselves*, and
nothing else — not heats, because seeding is the coach's call; not watches,
because you don't time your own race; not the athlete record, because editing
the name on it is how you'd quietly become someone else.

`app/state/auto-sync.tsx` pushes on its own, and is built to stay off the
render path:

- **Debounced ~2.5s.** Editing restarts the clock, so a burst of taps becomes
  one request. A full heat — start plus six lane stops — is one PUT.
- **One request at a time.** Anything edited mid-flight stays pending and goes
  out on the next pass, so there's no queue to grow.
- **Backs off on failure** (4s → 10s → 30s → 60s) rather than hammering dead
  pool wifi, and retries on `online` or when the tab comes back.
- **Gives up on 503/401.** A missing database or a bad token won't fix itself.
- **Push only.** Auto-pulling would let the server overwrite deck work behind
  your back, so pulling stays a deliberate button.
- **Switchable per device**, in localStorage rather than in the meet, so
  switching it off on the phone doesn't switch it off on the iPad.

The header chip shows the live state: Synced / Saving… / Retrying… / Local only.

### Reading, for everyone else

Browsing doesn't go through sync at all. A meet is a public event — the heat
sheet is handed out at the door and the results are read over a PA — so meets,
teams, rosters and results are readable with no account, straight from the
server. That split is what stopped the sync engine having to grow an opinion
about who may read what.

Two things never travel: **birth dates**, and **contact details**. `public.ts`
builds a public athlete by *naming the fields that may go out* rather than by
deleting the ones that mustn't, so a field added to `Athlete` later is private
until somebody decides otherwise.

| Route | Purpose |
| --- | --- |
| `GET /api/meets`, `/api/meets/:id` | Every meet; one meet with its results |
| `GET /api/teams`, `/api/teams/:id` | Every team; one team's seasons and roster |
| `POST /api/teams` | Mint an unclaimed opponent (signed in; refuses a duplicate name) |
| `GET /api/athletes`, `/api/athletes/:id` | People, and one person's history |
| `GET /api/users/:id` | Somebody's own dashboard — only ever their own |
| `GET /api/members` | The accounts on a team. Coaches only: it's contact details |
| `POST /api/athletes/:id/link` | Say which account a swimmer is. Coaches only |
| `POST /api/sync` | Send changed objects, take back what changed elsewhere |
| `GET /api/sync-status` | Whether a D1 binding exists |
| `POST /api/auth/start`, `/verify` | Send a login code; trade it for a session |
| `GET`/`PATCH`/`DELETE /api/auth/session` | Who's signed in; sign out |
| `GET`/`POST`/`PATCH`/`DELETE /api/memberships` | Who's on a team, and who wants to be |
| `GET`/`POST /api/invites` | Inspect or mint a one-time invitation |
| `GET`/`POST`/`DELETE /api/timer/grant` | The coach's end of the timing QR code |
| `GET /api/timer/meet` | One meet, as much as a timer may see |
| `POST /api/timer/watch` | Times coming off a deck |

## Timers

A lane is timed by whoever is standing at it, and they give no name — exactly
as they give nothing today when handed a stopwatch and a clipboard. **Meet →
Timers** prints a QR code for the timing table. Scanning it is the whole
credential.

That is a bearer token on a piece of paper on a pool deck, and it's meant to
be. The blast radius is kept small three ways: a grant is scoped to one meet,
it can only write times and introduce people, and it stops working the day
after the meet. Printing a new code retires the old one, which is also how you
revoke a sheet that's gone walkabout.

A timer picks a lane, and gets one big button at a time: START, then STOP, then
Submit. Times queue in localStorage and go up when there's signal, so the wifi
can be gone the whole meet and nothing is lost. A watch is keyed by heat, lane
and timer, so sending it twice is not two times.

**Several watches per lane make the official time.** One stands alone, two are
averaged, three or more take the median — which is the point of a third watch:
it outvotes a slow thumb rather than dragging an average toward it. Times
truncate to hundredths, never round up. The result is *derived*, never stored,
which is exactly what makes concurrent timing conflict-free: every device
computes the same answer from the same watches, so there's nothing to conflict
over. A coach's ruling — a DQ, a no-show, a typed-in time — outranks the lot.

A timer can also say who was actually in a lane. That rides on the *watch*, not
on the lineup: a timer correcting what they saw must never rewrite the coach's
running order. Where the lineup has an opinion it wins. An empty lane is the
lineup having no opinion, and there the timers are the only witnesses — an
exhibition swim, a late entry, a visiting swimmer nobody seeded — so the swim
is credited on their word and flagged as such rather than silently dropped.

Adding a swimmer nobody entered offers the teams actually racing. The server
mints the roster entry from the meet's own date and teams; the phone only says
which team was tapped. A grant can introduce a person it has never seen and
cannot edit one that already exists, so a code taped to a table can't rename
the roster.

## Accounts

Identity is a contact — an email address or a mobile number — and nothing else.
There's no password and no separate sign-up: a code goes to whatever was typed,
and a contact nobody has used before becomes an account when someone reads it.
The email carries a link with the code already in it as well as the code
itself, since a link only works when mail is read in the same browser and a
code always works.

The session token is stored on the device and sent as a bearer header, so it
survives a reload and a closed lid — a coach signs in once on the iPad that
lives in the swim bag. Tokens and codes are both stored hashed.

**Local data wins over the session.** A device that already holds the season
keeps working with no network and no session, which is the state a phone is in
when pool wifi drops mid-meet. Signing in is how a season gets _onto_ a device
and how the server knows whose it is — not a gate in front of a stopwatch.

Roles are `head_coach`, `coach`, `athlete`, `parent`, `viewer`; only coaches can
admit people or hand out invitations, and only an active membership carries any
power at all. Being a member is not permission to change things — see the write
rules under Sync. Timers are deliberately not a role: they hold a meet-scoped
grant instead, so they can work without giving a name.

**An account can be a swimmer.** A coach links one from the athlete's page,
choosing among people already admitted to the team — self-claiming would let
anyone assert they were anyone. Once linked, `/users/{id}` is that person's own
page: their teams, their meets, their times with bests marked. It answers only
for the person asking, so a coach requesting somebody else's gets a refusal
rather than a redacted copy.

**Claiming a team.** A team with no members is unclaimed, and the first person
to ask becomes its head coach; after that everyone else waits for approval.
That covers both the one-time bootstrap for seasons that predate accounts and
the opponent someone else created for you, so claim yours promptly.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173/projects/meet-runner/
npm run typecheck
npm run build
```

`wrangler dev` creates a local D1 automatically, so sync works in development
with no setup. `.dev.vars` sets `AUTH_DEV_CODES=1`, which hands the login code
straight back to the browser so you can sign in with no email or SMS provider
configured. It is gitignored, and must never be set on a deployed worker.

### Deploying

1. Create the database and paste the returned id into `wrangler.jsonc` in place
   of `REPLACE_WITH_D1_DATABASE_ID`:

   ```sh
   npx wrangler d1 create meet-runner
   ```

2. The sync endpoints are open by default. Since the worker is on a public
   route, set a shared secret and enter the same value under **Sync → Sync
   token** in the app on each device:

   ```sh
   npx wrangler secret put SYNC_TOKEN
   ```

3. Codes have to reach people somehow. Set whichever channels you want; a
   channel with nothing configured logs the code on the worker instead of
   sending it, and says so on screen rather than failing silently.

   ```sh
   npx wrangler secret put RESEND_API_KEY     # email
   npx wrangler secret put AUTH_FROM_EMAIL    # e.g. Meet Runner <meets@example.com>
   npx wrangler secret put TWILIO_ACCOUNT_SID # text messages
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM        # the sending number, in E.164
   ```

4. `npm run deploy`

5. Sign in, and claim the team — the first person to ask for an unclaimed team
   becomes its head coach.

Without step 1 the app still deploys and runs; only the sync buttons report
themselves unavailable.

#### Upgrading a database that predates scopes

`objects` used to be keyed by `team_id` and `meet_id`; it's keyed by `scope`
now. `CREATE TABLE IF NOT EXISTS` won't alter a table that already exists, so
deploying over an older database leaves the first write failing on a missing
column, with nothing on screen to explain it.

Back up first, then drop and recreate — deliberately, not as a side effect of
shipping:

```sh
npx wrangler d1 export meet-runner --remote --output backups/prod-$(date +%F).sql
npx wrangler d1 execute meet-runner --remote --command "DROP TABLE objects"
```

The table is rebuilt on the next request, and each device pushes its season
back up. Devices re-migrate on their own: a baseline in the old shape is
discarded rather than half-read, and athletes are recovered out of an older
team document the first time the new build launches.

## Not built

- Meet scoring. Swimmers carry an optional `squad`, which is imported, shown,
  and exported, but nothing totals points per squad yet — that's the natural
  next step if you want a running score during an inter-squad meet.
- Seed times, so heats are seeded in roster order rather than by speed.
  "Reseed lanes" in Run mode reshuffles at random.
- A screen for a swimmer to change their own entries. The permission exists —
  a linked account may enter and scratch itself — but the only way to use it
  today is the coach's registration grid. See `TODOS.md`.

## Operating notes

Back up the live database (see also the upgrade note above):

```sh
npx wrangler d1 export meet-runner --remote --output backups/prod-$(date +%F).sql
```

`backups/` is gitignored. It holds real rosters — minors' names, and birth
dates where they've been entered — so it stays on the machine that made it.

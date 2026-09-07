# Meet Runner

A phone/iPad app for managing a high-school swim team and high-school swim meets:
ability to add edit teams and their rosters (which carry across the years), ability to manage schedule of meets/entries, ability to run a meet including individual timer and coach's multi-lane
stopwatch.

Local-first. Everything lives on the device, so the app keeps working on a pool
deck with no signal. It backs itself up to the server in the background as you
go, and catches up on its own once signal returns.

## How it's organised

Two long-lived things: **the team** (the roster, which lasts the season) and
**meets** (one document per meet, each with its own events, entries and times).
Meets reference swimmers by id, so the roster is the single source of truth —
fixing a spelling in March fixes January's results too, and removing someone
_archives_ them rather than deleting, since live results still point at their id.

The bottom bar changes with where you are. At the top level it's **Team /
Meets / Settings**; open a meet and it becomes that meet's modes with a way
back out, so Run stays one thumb tap away while a heat is in the water.

## Team

The roster: import a CSV, add swimmers by hand, or tap through to a swimmer for
their details and every time they've swum, grouped by event with a best-time
marker and a link to each meet. Archiving is the only way off the roster.

Names are ordered and written per **Settings → Name order**, which applies to
the roster, registration, the lane buttons and the lane picker.

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

- `app/types/meet.ts` — `TeamDoc` and `MeetDoc`, both plain JSON (no
  `Map`/`Set`/`Date`) so the same value round-trips through IndexedDB and the
  server unchanged. `MeetDoc` holds swimmer _ids_ only.
- `app/lib/documents.ts` — defaults and version migrations, deliberately pure so
  the worker can share them without pulling in browser storage code.
- `app/lib/db.ts` — IndexedDB. A season outgrows localStorage (~150KB a meet
  against a ~5MB ceiling, and Safari's failure mode is a thrown quota error
  mid-write, which on a deck means losing times). Also carries the one-time
  migration that splits an old single-meet localStorage save into a team plus
  meet #1.
- `app/state/app-store.tsx` — context store holding the team and every meet in
  memory. Mutations go through `editTeam`/`editMeet`, which stamp `updatedAt`;
  an effect writes back only the documents whose identity changed, so editing
  one meet doesn't rewrite the season. Routes render nothing until the read
  finishes, which keeps SSR and the client in agreement.
- `app/lib/heats.ts` — seeding. Heats are filled so the short heat comes first
  and the last heat is full, and lanes fill from the middle of the pool outward
  (6 lanes: 3, 4, 2, 5, 1, 6).
- `app/hooks/use-stopwatch.ts` — the clock is always `Date.now() - startedAt`,
  never an accumulated counter, so it stays accurate through dropped frames, a
  backgrounded tab, a screen lock, or a reload mid-heat. Also holds a screen
  wake lock while a heat is running.
- `app/lib/meets.server.ts` + `app/routes/api.*.ts` — sync endpoints.

Times are stored as integer milliseconds and only formatted for display.

\*\*IMPORTANT: THE BELOW SYNC SECTION IS OUT OF DATE AND WAS NOT UPDATED AFTER
A REFACTOR TO THE LATEST OBJECT/SYNC MODEL - LEFT IN FOR NOW, BUT NEEDS CLEANUP
AS IT'S NO LONGER RELEVANT

### Sync

Whole-document push/pull against D1, resolved by `updatedAt` — a push older than
what the server holds is rejected rather than applied, so a stale tab on another
device can't clobber the live copy. Tables are created on first use; there's no
migration step.

The team and each meet are separate documents, and only the ones actually behind
get pushed. The roster always goes first: a meet's swimmer ids mean nothing to
another device until the roster they point into has landed.

**A device with no local data adopts the season rather than starting one.** It
never invents a team: signing in says which team this person is on, and the
device fetches that one. Without that, opening the app on a second device would
mint an empty team, push it, and shadow the real roster — the second device
would look empty while cheerfully reporting "Synced".

For the same reason auto-sync stays parked until the store has finished reading
storage: before that, the in-memory team is a throwaway placeholder, and pushing
it would put an empty roster on the server ahead of the real one.

`app/state/auto-sync.tsx` pushes on its own, and is built to stay off the render
path:

- **Debounced ~2.5s.** Editing restarts the clock, so a burst of taps becomes one
  request. A full heat — start plus six lane stops — is seven changes to the
  document and one PUT.
- **One request at a time.** Anything edited mid-flight stays pending (the push
  marks only the revision it actually sent) and goes out on the next pass, so
  there's no queue to grow.
- **Backs off on failure** (4s → 10s → 30s → 60s) rather than hammering dead pool
  wifi, and retries immediately on `online` or when the tab comes back — the two
  moments actually worth retrying.
- **Gives up on 503/401.** A missing database or a bad token won't fix itself;
  the header reads "Local only" and nothing is retried until you push by hand.
- **Push only.** Auto-pulling would let the server overwrite deck work behind
  your back, so pulling stays a deliberate button.
- **Switchable per device.** Sync → Auto-sync turns it off, after which nothing
  leaves the device until you tap _Push now_; the header falls back to
  Synced / Not synced. The preference lives in localStorage rather than in the
  meet, so switching it off on the phone doesn't switch it off on the iPad —
  and doesn't itself become a change that needs syncing. Turning it back on
  pushes immediately rather than waiting out the debounce.

The header chip shows the live state: Synced / Saving… / Retrying… / Local only.

One consequence worth knowing: whichever device last touched a meet wins. That
was true of the manual push too, but automatic pushing makes it easier to hit if
you leave the app open on a second device.

| Route                                          | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| `GET /api/sync-status`                         | Whether a D1 binding exists                            |
| `POST /api/sync`                               | Send changed objects, take back what changed elsewhere |
| `GET /api/teams`                               | The seasons the signed-in person may switch between    |
| `POST /api/auth/start`                         | Send a login code to an email or mobile                |
| `POST /api/auth/verify`                        | Trade the code for a session                           |
| `GET`/`PATCH`/`DELETE /api/auth/session`       | Who's signed in; record where they are; sign out       |
| `GET`/`POST`/`PATCH`/`DELETE /api/memberships` | Who's on a team, and who wants to be                   |
| `GET`/`POST /api/invites`                      | Inspect or mint a one-time invitation link             |

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
power at all. Timers are deliberately not a role — they'll hold a meet-scoped
grant instead, so they can work without giving a name.

**Claiming a team.** A team with no members is unclaimed, and the first person
to ask becomes its head coach; after that everyone else waits for approval.
That's the one-time bootstrap for seasons that predate accounts, so claim yours
promptly after deploying.

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

## Not built

- Relays.
- Meet scoring. Swimmers carry an optional `squad`, which is imported, shown,
  and exported, but nothing totals points per squad yet — that's the natural
  next step if you want a running score during an inter-squad meet.
- Seed times, so heats are seeded in roster order rather than by speed.
  "Reseed lanes" in Run mode reshuffles at random.

## Random dev notes/chat history

- backup D1 data
  ```sh
  npx wrangler d1 export meet-runner --remote --output meet-runner-pre-deploy.sql
  ``
  ```

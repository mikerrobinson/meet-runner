# Ideas & loose ends

Things suggested along the way that we didn't build, plus known rough edges.
Nothing here is committed to — it's a parking lot. Add your own freely.

---

## Next up

Roughly in the order that made sense when we stopped. Everything below this
section is still a parking lot — this part isn't.

### 1. Deploy, which needs a schema conversion first
`scripts/migrate-to-scopes.sql` turns the live `objects` table from
team/meet columns into a single `scope`. It has been run against a copy of the
2026-09-07 production backup and verified: 659 rows in, 659 out, correctly
scoped, and the new code read the result back with all 47 Chaparral athletes,
5 meets and 82 times intact.

The two steps that touch production have *not* been run:

```sh
npx wrangler d1 export meet-runner --remote --output backups/prod-$(date +%F).sql
npx wrangler d1 execute meet-runner --remote --file=scripts/migrate-to-scopes.sql
npm run deploy
```

Nothing is lost by it — athletes were already their own rows, and the only
invented field is a meet learning to name the team it used to belong to.

### 2. Verify the public-shell change with a working device
`shell.tsx` renders a minimal chrome on `/meets`, `/teams` and `/athletes` when
local storage isn't ready. Verified for the broken-storage case; **not**
verified for a signed-in coach with healthy storage, because the browser it was
tested in had its IndexedDB wedged. Reading the code it should fall through to
the normal shell once `ready` flips, with a brief flash of the minimal one.
If the bottom tab bar doesn't come back on `/meets` when signed in, that's the
change to look at.

### 3. Settle the bottom tab bar
Deferred with "decide once the screens exist". They exist now. It's still
Team / Meets / Browse / Settings, which predates meets becoming the home. The
suggestion on the table was Meets / Teams / Athletes with Settings moving into
the account menu, since that menu already covers Profile and sign-out.

### 4. An athlete's own screen
See below — the permission is built and verified, only the screen is missing.

### 5. Entry visibility on the wire
`meet.options.entryVisibility` is honoured by the entries screen but not by
sync: a coach who pulls a shared meet still receives every team's entries. The
UI hides them; the network doesn't. Restricting reads inside the cursor is the
harder half and was deliberately left.

### 6. Scoring
`ScoringRules` and `DUAL_MEET_SCORING` (6-4-3-2-1 / 8-4, split by gender) are
defined in `types/meet.ts` and computed by nothing.

---

## Features

### An athlete's own screen
Phase 3 linked accounts to roster entries and gave a linked swimmer permission
to enter and scratch *themselves* through `/api/sync` — verified, and refused
for anyone else's entries. What's missing is the screen. `/users/{id}` shows
their teams, meets and times read-only; there's nothing to tap to sign up for
the 100 Free.

The registration grid is the coach's tool — a roster down the side, every race
across the top — and is the wrong shape for one person. What a swimmer wants is
their own short list: the races in the next meet, which ones they're in, and
the entry limits (4 events, max 2 individual) counting down as they pick.

This is the use case the app was originally built for: iPads handed round on
deck before a meet so swimmers sort out their own entries. It's the only part
of that still missing, and the permission work is already done.

### Entry limits
NFHS caps a swimmer at 4 events, max 2 individual (varies by state). The
registration row already shows "3 ev" — turn it amber at the cap and red past
it. Small, and catches an illegal lineup before an official does.

### Dual-meet scoring, scored separately by gender
6-4-3-2-1 individual, 8-4 relay, with a running team score. The obvious missing
piece for a real dual meet, and the split girls/boys lineup is already the
structure it needs. The biggest item on this list.

### Auto-pair when adding an event
In a split lineup, adding "100 Fly" nearly always means adding both girls' and
boys'. Right now you add one and repeat. Could add the pair in lead order from
one tap.

### Live updates while a heat is on the clock
Polling is at two seconds now (`POLL_MS` in `auto-sync.tsx`), shortened for the
admin control desk, which watches three timers' watches land on one lane. That
is about the ceiling of what polling can sensibly do — the honest answer is a
push channel, which on Workers means Durable Objects. The object model
underneath is already the right shape for it: scoped, per-object,
last-write-wins.

### Tombstone retention
Deleted objects stay in the table forever; every un-entered swimmer leaves a
row. Harmless for a long while, but it wants a rule eventually — and you can't
safely purge until every device has seen the deletion, which is an argument for
tracking device cursors.

### SD3 import and export
The plan: read the standard `.sd3` files Hy-Tek, SwimTopia and Commit export, so
an opponent's lineup can be imported rather than typed, and write results back
out so a meet can be shared into whatever the other team runs. Needs teams as
first-class references first — an SD3 entry belongs to a team, not to "us".
Export is the easier half and the one that pays off immediately after a meet.

Swimmer birth dates are stored as of 2026-09-05, which SDIF needs on every
athlete record — though as of the 2026-09-07 production backup not one of the
96 athletes actually has one, so export needs them entered before it can work. Still missing for export: an LSC/club code for the team, and
whatever the exporter decides to do about athlete IDs — the legacy USS number
is derived from the birth date and name, but a real registration ID is not
something we can invent, so unregistered swimmers will need a fallback.

### ~~Teams as first-class references~~ — built
A meet now carries `teamIds` referencing real team documents, athletes are
global, and a team can exist unclaimed until a coach from that school signs in.
Two schools work the same meet rather than keeping half a copy each. This was
the prerequisite blocking SD3 and multi-team scoring; both are now unblocked.

### Copy the lineup from a previous meet
Cheaper than full reusable templates (which we passed on) and gets most of the
benefit — "same as last time" covers most of a season.

### Jump to the next unswum event
With 22+ events there's a lot of tapping past ones already done. A "next event
with entries and no times" jump would save it.

### Relay lane labels
A relay lane is currently held by a single swimmer standing in for the squad.
Letting a lane be labelled "Blue A" / "Gold B" instead would read better, at the
cost of a real relay model.

### Service worker (offline cold launch)
Installed to the home screen, the app still needs the network for the *first*
load of a session. Discussed in detail and deliberately deferred — if we do it:
network-first HTML, cache-on-demand for hashed assets with no eviction,
`/api/*` untouched, no `skipWaiting`. The conservative shape matters; the
aggressive one risks serving a stale build that can't be fixed remotely.

### Column striping on registration
Rows are striped now. Columns could be too, though doing both makes a
checkerboard — worth trying only if rows alone aren't enough on a wide grid.

---

## Safety / correctness

### False-start recovery
`Reset` is deliberately off-screen while a heat is live, so an early START
costs seven taps to unwind (stop every lane, then reset). Suggested fix:
long-press the running clock to reset — deliberate enough not to happen by
accident, one gesture instead of seven.

### "Next heat" is live mid-race
It sits bottom-right, big and blue, and ending a heat early drops times for any
lane that hadn't stopped. Could require a confirm while lanes are outstanding.

### Roster "Replace" orphans entries
Replace mints new swimmer ids, so entries and results in past meets end up
pointing at swimmers no longer listed. Matching incoming rows on name and
reusing the existing id would preserve history. Archive-and-add is the safe path
mid-season today.

This one has now happened for real, so the symptom is known: the counts said
"9 entered" and the grid drew three ticks. `entrySplit` in `events.ts` tells
entries apart from orphans, the entries grid explains itself in a banner, and
the admin rail marks affected events with an amber `!n`. That surfaces the
damage; it doesn't repair it. A re-import that matched on name would.

---

## Smaller polish

- **Import prompt below the fold.** The Add / Replace / Cancel prompt renders at
  the bottom of the Import card, under the whole roster — on a long roster it's
  off-screen and the import looks like it did nothing.
- **Lane tile truncation.** Full names ("Castellanos, Sofia") truncate more on a
  half-width grid tile than the old initials did. Fine in list layout.
- **Name order elsewhere.** Results, swimmer detail and the CSV export still use
  natural "First Last" rather than the Settings name order. Deliberate — those
  read as records rather than a scanned column — but worth revisiting. The
  preference itself now lives on the device rather than the team, since a
  visiting coach shouldn't change how the host reads its own roster; moving it
  on again to the user record would make it follow someone between devices.
- **Time entry keypad.** `inputMode` is still `decimal` though the "." is no
  longer needed; `numeric` would be a cleaner pad. Prefilling the field with
  bare digits would also make correcting a time a couple of taps instead of a
  retype.
- **Dead search box.** The registration search filter is still in the row
  expression but unreachable while `SHOW_ROSTER_CONTROLS` is `false`.
- **Diving is display-only.** By design — it shows on registration and holds
  its place in the running order, but carries no scores, so it never appears on
  the Results screen or in the CSV export. If dual-meet scoring lands, diving
  points would have to be typed in from the diving sheet.
- **Header title on narrow phones.** True-centring the Girls/Boys toggle caps
  the meet name at half the width on registration. Could centre only above a
  breakpoint if that bites.

---

## Your ideas

<!-- add below -->

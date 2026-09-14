# Ideas & loose ends

Things suggested along the way that we didn't build, plus known rough edges.
Nothing here is committed to — it's a parking lot. Add your own freely.

---

## Next up

Rewritten 2026-09-13, after the rebuild onto a server-authoritative model. The
old list below this section is still a parking lot; this part isn't.

### 1. Live updates while a meet is running

The one real gap. Screens read from loaders, and a loader only re-runs when
something on *this* device navigates or finishes a write — so the control desk
does not see a time arriving from a phone until somebody touches something. On
a deck that is the difference between watching times land and refreshing.

Two options, in order of cost:

- **Poll the meet route.** A `useRevalidator` on an interval while the run and
  entries screens are visible. Perhaps twenty lines. Was ~2s before, which is
  about the ceiling of what polling can sensibly do.
- **Push, via a Durable Object per meet.** The honest answer, and now a much
  smaller job than it was: one object holding a meet's rows and fanning changes
  out over a socket. The write endpoints are already small and single-row,
  which is the shape a DO wants.

Do the first now; the second when it's worth it.

### 2. The stopwatch screen has had the least use

`run.tsx` compiles and renders, and the control desk has been exercised
properly against a real database — the deck stopwatch has not been driven
through a whole heat since the rewrite. Before a meet: START, stop several
lanes, Reset, Next heat, and the lane sheet's "Replace my time".

Known cosmetic thing: on a *re-swim*, lanes carrying times from the previous
swim render green with those times rather than a red STOP, so it's not obvious
which lanes still need taking here. Tapping them works.

### 3. Two things dropped in the rebuild, if you want them back

- **Whole-season JSON import**, under Settings. Export stays. Restoring a
  season into a shared server is a genuinely different operation from restoring
  a device, and it wasn't worth guessing at.
- **"Add swimmer" on the entries grid.** It wrote a roster row from the entries
  screen; that's the team screen's job now. Cheap to add back as a shortcut.

### 4. Scoring

`ScoringRules` and `DUAL_MEET_SCORING` (6-4-3-2-1 / 8-4, split by gender) are
defined in `types/meet.ts` and computed by nothing. The biggest genuinely
missing feature, and the entries/results shape is ready for it.

### 5. Settle the site navigation

Bottom bar is still Team / Meets / Browse / Settings, which predates meets
becoming the home. The suggestion on the table was Meets / Teams / Athletes
with Settings moving into the account menu, since that menu already covers
profile and sign-out.

### 6. An athlete's own screen

The permission is built and enforced (`athletesMayEnter` + `mayEnter`); the
screen is missing. A swimmer wants their own short list — the races in the next
meet, which ones they're in, and the limits counting down as they pick — not
the coach's grid. This is the use case the app was originally built for.

## Features

### An athlete's own screen

Phase 3 linked accounts to roster entries and gave a linked swimmer permission
to enter and scratch _themselves_ through `/api/sync` — verified, and refused
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


### Column striping on registration

Rows are striped now. Columns could be too, though doing both makes a
checkerboard — worth trying only if rows alone aren't enough on a wide grid.

---

## Safety / correctness

### ~~Roster "Replace" orphans entries~~ — gone with the rewrite

Enrollment ids are derived from season and athlete, so a re-import updates rows
rather than minting new people, and `meetDetail` fetches exactly the people its
rows name. There is nothing left to be orphaned from.

### False-start recovery

`Reset` is deliberately off-screen while a heat is live, so an early START
costs seven taps to unwind (stop every lane, then reset). Suggested fix:
long-press the running clock to reset — deliberate enough not to happen by
accident, one gesture instead of seven.

### "Next heat" is live mid-race

It sits bottom-right, big and blue, and ending a heat early drops times for any
lane that hadn't stopped. Could require a confirm while lanes are outstanding.


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
- **The old "Add / Replace" import prompt** on the team screen now posts to an
  action rather than a store, so the note above about it rendering below the
  fold is worth re-checking against the rewritten screen before acting on it.
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

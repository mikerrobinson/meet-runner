# Ideas & loose ends

Things suggested along the way that we didn't build, plus known rough edges.
Nothing here is committed to — it's a parking lot. Add your own freely.

---

## Features

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

### Teams as first-class references
Prerequisite for the above, and for scoring more than one team. Open question
worth settling early: a meet's teams as references to team documents (so
rosters and lineups can be imported and reused) rather than labels on a meet.

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

### Stale pushes are marked synced
When the server rejects a push as stale (`applied: false`), the client still
marks it synced. It stops a retry loop, but a genuine divergence passes quietly.

### Deletes don't sync
Deleting a meet on one device leaves it on the server and on other devices.

### Orphaned team rows
The duplicate-team bug left a stray empty team row in D1. It loses the tiebreak
permanently so it's harmless, but a cleanup on push would tidy it.

---

## Smaller polish

- **Import prompt below the fold.** The Add / Replace / Cancel prompt renders at
  the bottom of the Import card, under the whole roster — on a long roster it's
  off-screen and the import looks like it did nothing.
- **Lane tile truncation.** Full names ("Castellanos, Sofia") truncate more on a
  half-width grid tile than the old initials did. Fine in list layout.
- **Name order elsewhere.** Results, swimmer detail and the CSV export still use
  natural "First Last" rather than the Settings name order. Deliberate — those
  read as records rather than a scanned column — but worth revisiting.
- **Time entry keypad.** `inputMode` is still `decimal` though the "." is no
  longer needed; `numeric` would be a cleaner pad. Prefilling the field with
  bare digits would also make correcting a time a couple of taps instead of a
  retype.
- **Dead search box.** The registration search filter is still in the row
  expression but unreachable while `SHOW_ROSTER_CONTROLS` is `false`.
- **Sync payload size.** Each push sends the whole document (~80–150KB for a
  full meet). Fine on wifi, less so on cellular. Deltas would fix it at a real
  cost in complexity.
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

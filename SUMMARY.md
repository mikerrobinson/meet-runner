# Where this is up to

Written 2026-09-10, at the end of a long stretch of work that reset the data
model and then rebuilt the screens on top of it. `README.md` describes how the
app works today; this describes how it got here, what's half-finished, and
where the sharp edges are — the things that are true right now and won't be in
a month.

Start with **Next up** in `TODOS.md`.

---

## The short version

The app began as one coach running one inter-squad meet, and the model said so:
everything belonged to a team, and a meet was something a team owned. Adding
multiple meets, then seasons, then accounts each bent that shape a little
further, until a dual meet had to be stored as two half-copies and a visiting
swimmer had to be retyped into the home roster.

Four phases fixed the shape:

| | |
| --- | --- |
| **1** | Athletes became global people; meets became standalone objects referencing teams; sync re-scoped from `team_id` to `team:` / `meet:` / `global` |
| **2** | Public read and a REST surface — browsing stopped going through the sync engine |
| **3** | Identity joined the model: accounts link to athletes, meets have administrators, multiple contacts per account |
| **4** | Deleted what was dead and rewrote the docs against the model that exists |

Then a UI pass, because the screens still followed the old premise: a meets
list as home, meet sections, and a control desk for running a meet.

**The load-bearing idea:** a meet belongs to no team. Two schools open the same
meet, neither owns it, and neither sees the other's roster. Everything else
falls out of that.

---

## The model, in one screen

Three things, and only one of them owns anything.

- **Athlete** — a person. Global, durable, belongs to no team. Never deleted,
  because results reference people by id forever.
- **Team** — owns its seasons, and says through **enrollments** who swam for it
  and when. Does *not* hold its athletes.
- **Meet** — one day's racing between one or more teams, referencing them by
  `teamIds`. Belongs to none of them.

Everything syncs as small **objects** carrying a **scope**:

| Scope | Holds |
| --- | --- |
| `team:{id}` | team, seasons, enrollments |
| `meet:{id}` | meet, lineup, entries, heats, watches, rulings, results |
| `global` | athletes |

### Times: evidence, judgement, decision

This is the part most worth understanding before changing anything.

1. **Watches** are evidence. Several per lane, one per timer, keyed by
   `heat:lane:timer` so re-sending is not duplicating. Nobody overwrites
   anybody.
2. **Rulings** are judgements — a DQ, a no-show, or a time entered by hand.
   Admin-only, and stamped with `decidedBy` and `decidedAt` like any other
   claim. A typed time outranks the watches but is *not* a sign-off: keeping
   the two apart is why undoing an acceptance returns to the official's own
   reading rather than back to the raw watches. Status and typed time are two
   fields on one ruling and neither erases the other — marking a DQ keeps the
   time that was entered.
3. **Results** are decisions. An administrator accepts a lane, as the watches
   have it or corrected, and *that* is what the meet reads.

Two things fall out of storing the acceptance rather than deriving everything:

- **A late watch is harmless.** A timer's phone that was offline all afternoon
  can push whenever it reconnects; the meet reads results from the acceptance,
  so nothing moves. It's still recorded and timestamped, so a call can be
  reopened deliberately. Verified with a garbage 9.999-second 50 Free arriving
  after sign-off: recorded, ignored, result unmoved.
- **"Closed" needs no storage.** A heat is closed once every lane that *swam*
  has been accepted; an event once all its heats are. Derived, so it can never
  disagree with the results underneath it.

`activeLanes` decides what "swam" means: seeded lanes, plus any empty lane a
timer put a name to. So an exhibition swim holds a heat open until somebody
decides about it; an untouched empty lane doesn't.

**The timer screen is on its own path, not the sync engine.** It reads
`/api/timer/meet` and writes `/api/timer/watch`; the deck and the admin desk
use `/api/sync`. That's deliberate — a phone behind a QR code holds no season
and needs no IndexedDB — but it means the timer needs its own polling, which it
lacked entirely: it read the meet once on opening and never again. It now
refreshes every 3s while visible.

**Who's in a lane is its own write.** It used to ride on the watch, so a
correction made behind the blocks reached nobody until the race finished. A
`seat` is queued and sent like a time — offline-tolerant, and applied by
`seatFromWatch` the same way — so a name fixed before the start shows up on the
admin desk and the other timers' phones within seconds.

**A timer naming a different swimmer moves the lineup.** It used to do nothing
at all on a seated lane — the claim rode on the watch and every reader
preferred the seeding, so the one case the control existed for was the one it
couldn't fix. The server now applies it (`seatFromWatch`), from the meet's own
heat rather than from anything the phone sends: a grant may say "lane 4 was
Dana", never what the running order is. Whoever was displaced keeps their entry
and loses their lane, so the disagreement becomes an empty lane the other timer
has to fill rather than two lanes claiming the same swimmer.

### Who may do what

Roles are team-scoped except one. **Running a meet is scoped to the meet**,
because a meet belongs to no team — often it's the host's coach, sometimes a
referee who coaches nobody. Whoever first pushes a meet to the server
administrates it, which keeps your own inter-squad meet behaving as it always
has.

| | Meet admin | Coach of a racing team | Linked athlete |
| --- | :-: | :-: | :-: |
| Meet details, lineup, heats | ✓ | | |
| Rulings, accepted results | ✓ | | |
| Watches | ✓ | ✓ | |
| Entries | ✓ | their own team's | themselves, if the meet allows |

Watches and rulings sit on opposite sides deliberately: a watch is evidence and
an extra one never overwrites anybody, so every coach keeps their stopwatch. A
ruling is a decision, and with two schools in the water it isn't one school's
to make.

Enforced server-side in `api.sync.ts`, not just hidden in the UI.

---

## What's on disk

```
app/lib/objects.ts        decompose/recompose the model as scoped objects (pure)
app/lib/timing.ts         watches → official time; accepting; derived closing
app/lib/public.ts         what anyone may see, and the redaction (pure)
app/lib/public.server.ts  the browsing reads, over D1
app/lib/sync.server.ts    the one `objects` table and the cursor
app/lib/admins.server.ts  who runs a meet
app/routes/run-control.tsx  the admin control desk
app/state/meet-role.tsx     "what am I in this meet", asked of the server
scripts/migrate-to-scopes.sql   the deploy-blocking schema conversion
backups/                        production dumps, gitignored
```

Ten test suites, `npm test`. They pin the properties that matter: the object
round trip, the timing rules, acceptance and closing, entry limits, and that a
birth date cannot reach a public response.

---

## Sharp edges

**Deploying needs the conversion first.** The live `objects` table still has
`team_id`/`meet_id` and no `scope`. `CREATE TABLE IF NOT EXISTS` won't reshape
it, so the first write after a deploy fails on a missing column with nothing on
screen to explain it. See Next up #1.

**Two things are private, and only two.** Birth dates and contact details.
`public.ts` builds a public athlete by *naming the fields that may travel*
rather than deleting the ones that mustn't — so a field added to `Athlete`
later is private until somebody decides otherwise. Keep it that way.

**Never `indexedDB.deleteDatabase()` from a page that has it open.** It blocks
behind the connection, the reloaded page's `open()` queues behind the delete,
and the database is wedged for the whole origin — surviving reloads and new
tabs. Only DevTools → Application → Clear site data (or quitting Chrome) clears
it. `openDb()` now times out after 5s instead of hanging forever, and public
pages render without local storage at all, but the deadlock itself is a browser
behaviour we can't undo from inside.

**Orphaned entries are a live condition, not a hypothesis.** Re-importing a
roster mints new athlete ids and leaves entries pointing at the old ones. They
count but don't render, which read as "9 entered" above three ticks.
`entrySplit` now tells them apart and both screens say so. See TODOS.

**A dev device and production are different worlds.** `npm run dev` talks to a
local D1 under `.wrangler/`; production is only reachable from the deployed
worker. A device that only ever synced in dev has data that exists nowhere
else — which is how a local roster of 47 was lost with no server copy while
production sat untouched.

---

## Things I'd want to know before touching them

- **The lineup is one object on purpose.** Reordering is a statement about the
  whole list; merging two independent reorderings would produce a programme
  neither coach wrote. Don't split it into per-event rows without solving that.
- **Results are derived except where accepted.** `resultForLane` returns the
  acceptance if there is one, otherwise a proposal from the watches. Every
  caller — results screen, CSV, public API, athlete history — inherits that.
- **`updatedAt` is the editing device's clock; `server_at` is ours.** The first
  decides who wins a contest for an object, the second is what a cursor pages
  through, so a device with a wrong clock can't hide a change from everyone.
- **The sync baseline is a cache, not data.** If it looks like it came from an
  older build it is discarded whole, never half-read — a partial baseline reads
  as "everything missing was deleted here", and the next push would say so.

---

## What kept catching bugs

Running it. Across four phases, the typechecker and the tests never caught the
ones that mattered:

- raw SQL naming a column that no longer existed (invisible to TypeScript)
- the public pages sitting behind a sign-in gate, unreachable for the people
  they exist for
- an athlete able to rename the whole team through `/api/sync`
- a user's contact details written to the worker log on every dashboard load
- a stale `useMemo` that would have shown a roster that never refreshed

All found by loading the thing in a browser or curling the endpoint. Tests and
types are necessary here and have never been sufficient.

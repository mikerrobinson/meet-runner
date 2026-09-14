# Running a meet: the model, and how we get there

Written 2026-09-12, after stepping back from the admin/timer work in `cf84b36`.
`SUMMARY.md` describes the model that exists; this describes the one we're
heading for and the order we get there in.

---

## The thing we are building

Two or three timers stand behind each lane with stopwatches. They ask who's in
the lane, they take a time, they write the team, the name and the time on a
sheet. A runner collects the sheets and hands them to an administrator, who
types them into a spreadsheet and eventually scores the meet.

We are crowd-sourcing that data entry, pre-populated from each team's entries
where we have them. Everything below follows from that sentence. Where the app
disagrees with the paper, the paper is usually right.

---

## The model

Four objects. Nothing is derived from two sources.

| Object | Key | Written by | Contention |
| --- | --- | --- | --- |
| `heat` | `heatId` | admin | none — the running order is the admin's |
| `seat` | `heatId:lane` | admin **or** timer | last write wins |
| `watch` | `heatId:lane:timerId` | anyone | none — one row per person |
| `call` | `heatId:lane` | admin | last write wins |

**A seat is the only answer to who is in a lane.** The coach seeding an event,
the admin correcting the desk, and the timer fixing a name behind the blocks
all write the same row. Last-write-wins is right because it is one person
deciding one thing. There is no second opinion riding on the watch, no vote
between claims, and no server-side rule reconciling the two.

**A watch is evidence and is never overwritten.** One row per timer per lane,
keyed so a re-send is not a duplicate. Several watches on a lane produce a
*proposed* time by the hand-timing rules — one stands, two average, three or
more take the middle.

**A call is the decision, and there is exactly one per lane.**

```ts
interface LaneCall {
  id: string;              // heatId:lane
  eventId: string;
  heatId: string;
  lane: number;
  /** Set only when the call corrects who swam. Otherwise read the seat. */
  athleteId?: string;
  status: ResultStatus;    // OK | DQ | NS
  /** The official's own reading. Absent means "what the watches say". */
  timeMs?: number;
  /** Signed off. Until then the lane is a proposal. */
  final: boolean;
  by?: string;
  at: number;
  /** What the watches said at the moment it was signed off. */
  fromWatches?: { timeMs: number; watchCount: number; method: string };
}
```

This replaces `ruling` and `result`, which were two rows written on one tap.
The property that justified keeping them apart still holds: undo flips `final`
to false and keeps `timeMs`, so taking back a sign-off returns to the
official's own reading rather than to the raw watches.

**Nothing about a clock is stored in the meet.** A stopwatch is a device fact.
The deck screen holds `startedAt` in device state exactly as `/timer` already
does, and where each device has got to in the running order is device state
too. Neither goes over the wire.

Still derived, still unstorable: the proposed time, which lanes are active, and
whether a heat or an event is closed.

---

## What this steps back from

Three things that were right when they were built and stopped being right.

**`watch.athleteId` as a claim.** It was deliberately not the lineup — a timer
must not rewrite the coach's running order. Then it turned out that meant the
one case the control existed for was the one it couldn't fix, so
`seatFromWatch` was added to apply the claim to the seat after all. Now a claim
moves the lineup *and* lingers as a competing signal that renders "a timer says
somebody else". Two answers to one question. On paper the name the timer writes
is the fact.

**`ruling` plus `result`.** Evidence → judgement → decision is one layer more
than the job has. The desk writes both rows on a single tap.

**`meet.timer` in `MeetCore`.** It syncs, so:

- `startTimer` deletes every watch and ruling for the heat, and that deletion
  propagates. A coach tapping START on the deck erases times the timer phones
  have already sent.
- `setProgress` nulls it, so purely local navigation clears a globally visible
  clock.
- The timer phones never read it. They run their own stopwatch. The one shared
  thing is not shared with the people who need it.

`rebuildHeats` has the same shape: it drops the event's watches and rulings and
mints new heat ids, orphaning seats, watches and results — the roster-"Replace"
failure already logged in `TODOS.md`.

---

## Phases

One-shot conversions, not compatibility shims.

### 1. Take the clock and the cursor out of the document — **done**

- `TimerState` and `MeetDoc.timer` are gone, and so is `timer` on `MeetCore`.
  `MEET_DOC_VERSION` is 9. The deck stopwatch lives in `state/run-clock.tsx`
  and never reaches IndexedDB or the wire.
- START clears **this device's own** watches for the heat and nobody else's.
  So does Reset. Neither touches a ruling: a DQ or a typed time is a decision,
  not this device's evidence.
- `MeetDoc.progress` moved to `storage.ts`, keyed by meet id. The
  `applyFromSync` patch that carried it across a pull is gone with it.
- `reseedHeats` in `heats.ts` refuses once anything is recorded against the
  event, and reuses the existing heats' ids in place. `setLaneCount` keeps
  heats by the same test, heat by heat rather than event by event.

Three things only running it caught, all in how the deck decides a heat is
finished:

- Stoppability was read off the lane's *result*, so a time arriving from a
  phone locked the button here — the opposite of what an extra watch is for.
  `LaneTile` now takes `stoppedHere` separately from `result`.
- Counting only this device's watches left a coach who times two lanes waiting
  forever on the four the phones cover.
- Counting every result made pressing START on a re-swim declare the heat over
  on the spot. The clock records which lanes already had a time when it
  started, and those don't count until somebody takes them again.

### 2. The seat is the answer

- Remove `athleteId` from `WatchTime`, and `attributedAthlete` from
  `timing.ts`. `resultForLane` and `activeLanes` lose the attribution branch: a
  lane with a watch and no seat is a time with no swimmer, which is a hole for
  a human to fill, shown as such on the desk.
- Delete `seatFromWatch`. Seating becomes one pure function — seat here, vacate
  the duplicate lane, enter the swimmer in the event — shared by
  `assignToLane` and the timer client. The server validates scope and stores;
  it stops deciding.
- `run-control` drops the "per timer" and "a timer says…" branches.

### 3. One call per lane

- `Ruling` and `AcceptedResult` become `LaneCall`; `meet.rulings` and
  `meet.results` become `meet.calls`; object types `ruling` and `result` become
  `call`.
- `timing.ts`: `officialTime` → `proposedTime`; `resultForLane` reads the call
  and falls back to the watches.
- `app-store`: `setLaneStatus` / `overrideLaneTime` / `acceptLane` /
  `unacceptLane` / `acceptHeat` collapse into `setCall` / `finalizeLane` /
  `finalizeHeat`. The desk's `save()` becomes one write.
- A conversion script alongside `scripts/migrate-to-scopes.sql`, since the
  production backup holds real meets.
- `tests/timing.test.ts` and `tests/objects.test.ts` follow.

### 4. Timer path onto the same objects

- `/api/timer/meet` returns `{ cursor, objects[] }` from `pullObjects` with the
  timer redaction, and the phone recomposes with `fromObjects`. Deletes
  `timerSnapshot`'s second copy of heat assembly.
- `/api/timer/watch` validates that every object is a type a grant may write —
  `watch`, `seat`, `athlete`, `entry` — and in the right scope, then calls
  `pushObjects`. `visitorEnrollment` stays: a grant genuinely may not name a
  team's season.
- The localStorage outbox holds `SyncObject`s.

### 5. Push instead of polling

Only after the above. One Durable Object per meet, holding the meet's objects
and fanning changes out over a socket; `POLL_MS` and `SNAPSHOT_POLL_MS` go. A
transport change, not a model change, and much smaller once there is one object
stream instead of two.

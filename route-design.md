## Root & Shared Routes

`/meets`

Index of available meets.

`/meets/:meet_id`

Meet landing page displaying overview metadata (name, date, facility/course, schedule).

## Public & Informational Views (Standard REST Projections)

`/meets/:meet_id`

Meet program overview; list of all scheduled events.

`/meets/:meet_id/:event_id`

Event detail page showing declared entries, heat seeds, and current results.

`/meets/:meet_id/entries`

Entry declaration and registration grid — every event as a column, every
eligible swimmer as a row. Coaches and admins declare/scratch across the
whole lineup at once. Same URL and same screen as today; not part of this
migration's scope.

`/meets/:meet_id/results`

Results landing page / selector.

`/meets/:meet_id/results/:view`

Parameterized results views:

```
   /meets/:meet_id/results/by-event
   /meets/:meet_id/results/by-swimmer
   /meets/:meet_id/results/team-scores
```

## Timer Workspace (viewtype-First, Offline-Resilient)

`/meets/:meet_id/timer`

Layout / Workspace Shell.

Validates ephemeral timer bearer grant / QR session. Loads the full meet manifest once into memory via clientLoader. Holds full-screen mobile kiosk layout (h-dvh, locked scrolling, wake lock).

`/meets/:meet_id/timer/:event_id/:heat/:lane`

Leaf Route (Timing Kiosk).

Renders the touch-timed stopwatch, optional partner watch inputs, and submission form for a specific lane. Its co-located clientAction / action receives the POST, writes to the fallback disaster-recovery cookie/queue, and flushes to the Meet Durable Object.

## Admin Workspace (viewtype-First, Desktop / Tablet Desk)

`/meets/:meet_id/admin`

Layout Shell.

Protected by verified user session (requireMeetAdmin). Manages the primary WebSocket connection to the Meet Durable Object.

`/meets/:meet_id/admin/:event_id/:heat`

Leaf Route (Heat Reconciliation Desk).

Displays the live 6-to-8 lane matrix for the active heat, color-coded timer submission feeds, spread flags, walk-up swimmer overrides, and the "Approve & Lock Heat" action.

## Coach Workspace (viewtype-First, Specialized Tools)

`/meets/:meet_id/splits`

Layout Shell.

Protected by verified coach session.

`/meets/:meet_id/splits/:event_id/:heat`

Leaf Route (Multi-Lane Stopwatch).

Multi-watch split tracker for coaches taking split times across multiple lanes simultaneously. Saves to private local storage or personal coach logs without writing to official meet timing records.

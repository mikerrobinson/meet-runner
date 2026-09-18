# Swim Meet Manager — UI, Layout & Component Architecture Specification

## 1. Architectural Strategy: The Workspace Shell Pattern

To satisfy the divergent device constraints and connectivity profiles across pool-deck roles, routes are organized into **`viewtype`-first workspace trees**. Each workspace acts as a self-contained layout shell with its own data loader strategy, security boundaries, and viewport ergonomics.

---

## 2. Workspace Shells & Layout Trees

### A. Timer Workspace Shell (`/meets/:meet_id/timer`)

- **Target Device:** Mobile phone in direct sunlight; single-hand operation; wet hands.
- **Layout File:** `app/routes/meets.$meetId.timer.tsx`
- **Layout Responsibilities:**
  - Enforces `h-dvh`, locked overscroll/bounce (`overscroll-none`), and high-contrast styling.
  - Requests and holds the browser **Screen Wake Lock API** (`navigator.wakeLock`).
  - Provides a sticky top-bar displaying: Current Event/Heat, Lane indicator, Network status (Online / Queued Offline indicator), and a quick Lane-Switch dropdown.
  - Holds the background outbox retry loop for flushing queued cookie payloads.
- **Data Scaffolding (`clientLoader`):**
  - Downloads the entire meet manifest (events, heats, lane assignments, seeded athletes) on initial mount once.
  - Child leaf routes read directly from this parent loader cache using `useRouteLoaderData("routes/meets.$meetId.timer")`, completely bypassing network calls during heat-to-heat navigation.

### B. Admin Workspace Shell (`/meets/:meet_id/admin`)

- **Target Device:** Laptop or tablet at the scorer's/starter's table.
- **Layout File:** `app/routes/meets.$meetId.admin.tsx`
- **Layout Responsibilities:**
  - Desktop-first layout with collapsible event/heat navigation drawer.
  - Manages the persistent, bidirectional WebSocket connection to the Meet Cloudflare Durable Object (DO).
  - Global status bar showing connected timer devices, active heat indicator, and unverified heat alerts.
- **Data Scaffolding:** Standard server `loader` querying live heat states directly from the DO.

### C. Coach Splits Workspace Shell (`/meets/:meet_id/splits`)

- **Target Device:** Tablet or mobile phone on the deck bleachers/bulkhead.
- **Layout File:** `app/routes/meets.$meetId.splits.tsx`
- **Layout Responsibilities:**
  - Standalone multi-watch timing utility.
  - Manages an isolated in-memory or `localStorage` split ledger completely decoupled from the meet's official `OfficialResult` tables.

---

## 3. Core Component Specifications

### 1. `TouchStopwatch` Component

Used within the Timer Leaf Route. Built to bypass typical mobile browser touch latencies.

- **Touch Handling:**
  - Listens exclusively to `touchstart` / `pointerdown` (never `click`) to eliminate mobile browser 100–300ms click delays.
  - Records the native hardware event timestamp (`e.timeStamp` or `Date.now()`).
- **Time Calculation:**
  - Strict delta calculation against start epoch:
    $$\Delta t = t_{\text{stop\_epoch}} - t_{\text{start\_epoch}}$$
  - Display loop powered by `requestAnimationFrame` for a smooth 60fps display; **never** relies on `setInterval` or `setTimeout` (which throttle when tabs background or screens dim).
- **Hit Area:** The stop trigger occupies the entire bottom 50% of the mobile viewport with high-contrast active states.

### 2. `TimerForm` Component (Hybrid Stopwatch / Clipboard)

The interactive form rendered on `/meets/:meet_id/timer/events/:eventId/heats/:heat/lanes/:lane`.

- **Component Structure:**
  - **Header:** Event name, Heat number, Lane number, and expected swimmer name (with a 1-tap "Swap / Walk-up Swimmer" trigger).
  - **Primary Watch Zone:** Prominent `TouchStopwatch` button auto-populating "Watch 1".
  - **Partner Backup Inputs:** Two compact numeric text boxes ("Watch 2", "Watch 3") with oversized number-pad keyboards (`inputMode="decimal"`).
  - **Calculated Preview:** Live client-side calculation preview showing median/average as numbers are entered.
  - **Status Toggles:** One-tap chips for "DQ", "No Show / DNS", "Exhibition".
  - **Submission Button:** "Submit & Next Heat" trigger.
- **Action & Queue Flow:**
  - Wrapped in Remix `<fetcher.Form>` targeting the current route.
  - `clientAction` stages the submission into the `pending_time_${lane}` cookie before network dispatch.
  - On tap, the UI updates optimistically, advances the URL cursor to the next heat via `setSearchParams({ replace: true })`, and flushes the POST payload in the background.

### 3. `AdminReconciliationGrid` Component

The live deck matrix rendered on `/meets/:meet_id/admin/events/:eventId/heats/:heat`.

- **Component Structure:**
  - An 6-to-8 row table (one row per pool lane).
  - **Columns:** Lane # | Assigned Swimmer | Timer 1 (Live) | Timer 2 (Live) | Timer 3 (Live) | Computed Time | Variance Flag | Action.
- **Visual States:**
  - **Empty / Unseeded:** Muted gray.
  - **Pending Touch:** Yellow pulse / live stopwatch timer.
  - **Received & Verified:** Clean green with computed official time.
  - **Variance Alert:** High-contrast red badge when spread exceeds 300ms ($\max - \min > 0.30\text{s}$), rendering an inline time-adjustment dropdown.
  - **Walk-Up / Unassigned:** Orange pill highlighting that a time was submitted for an unseeded lane, with an inline "Assign Athlete" auto-complete modal.
- **Primary Action:** Global "Lock & Approve Heat" button that commits all verified lane results to official meet standings and broadcasts `HEAT_ADVANCED` via the DO WebSocket.

### 4. `MultiLaneSplitBoard` Component

Rendered on `/meets/:meet_id/splits/events/:eventId/heats/:heat`.

- **Component Structure:**
  - Compact vertical stack or grid of 6–8 independent lane stopwatches.
  - Global "Start All Heats" button syncing the gun start across all active lanes.
  - Individual lane "Split" and "Finish" buttons recording rolling lap splits per lane.
  - Export modal allowing coaches to copy tab-delimited split matrices or download a local CSV.

---

## 4. Complete Route-to-Component Mapping

| Route                                                     | Viewport Type          | Primary Layout / Component                                | Mutation Target (`action`)                                                 |
| :-------------------------------------------------------- | :--------------------- | :-------------------------------------------------------- | :------------------------------------------------------------------------- |
| `meets/`                                                  | Responsive             | `MeetsIndex` (Card list of active/past meets)             | N/A                                                                        |
| `meets/:id`                                               | Responsive             | `MeetDetail` (Schedule, facilities, settings)             | Admin settings update                                                      |
| `meets/:id/events`                                        | Responsive             | `EventsList` (Event schedule, heat counts)                | Add/order events                                                           |
| `meets/:id/events/:eventId`                               | Responsive             | `EventDetail` (Psych sheets, heat sheets, entries)        | Scratch/declare entries                                                    |
| `meets/:id/events/:eventId/heats/:heat/lanes/:lane`       | Mobile / Deep Link     | `LaneDirectViewer` (Read-only lane sheet / fallback)      | REST fallback action                                                       |
| `meets/:id/timer`                                         | Mobile Kiosk (`h-dvh`) | `TimerWorkspaceLayout` (Loads manifest; persistent shell) | N/A                                                                        |
| `meets/:id/timer/events/:eventId/heats/:heat/lanes/:lane` | Mobile Kiosk           | `TimerForm` + `TouchStopwatch`                            | `clientAction` $\rightarrow$ `action` (Ingests watch times, clears cookie) |
| `meets/:id/admin`                                         | Desktop / Tablet       | `AdminWorkspaceLayout` (WebSocket connection bar)         | N/A                                                                        |
| `meets/:id/admin/events/:eventId/heats/:heat`             | Desktop / Tablet       | `AdminReconciliationGrid`                                 | Approve heat, assign swimmer, override time                                |
| `meets/:id/splits`                                        | Responsive / Tablet    | `CoachWorkspaceLayout` (Local storage sync)               | N/A                                                                        |
| `meets/:id/splits/events/:eventId/heats/:heat`            | Tablet / Mobile        | `MultiLaneSplitBoard`                                     | Save personal split log                                                    |
| `meets/:id/results`                                       | Responsive             | `ResultsSelector`                                         | N/A                                                                        |
| `meets/:id/results/:view`                                 | Responsive             | `ResultsTable` (Filterable by event, swimmer, team)       | N/A                                                                        |

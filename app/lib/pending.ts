/**
 * What the screen shows while the outbox is still catching up.
 *
 * Loader data is what the server has acknowledged. The queue is what this
 * device has said since. Folding the second over the first is what makes a tap
 * feel instant on good wifi and keep working on none — and it's a pure
 * function of both, so there is no third copy of the meet to fall out of step.
 *
 * Every write's effect here has to match what the server does with it, and
 * that pairing is the only thing to be careful about in this file: if a write
 * grows a rule on the server, it grows the same rule here.
 */

import type { MeetDetail, Watch } from "~/types/meet";
import type { Queued } from "./outbox";

export function applyPending(detail: MeetDetail, queue: Queued[]): MeetDetail {
  const mine = queue.filter((q) => q.write.meetId === detail.meet.id);
  if (mine.length === 0) return detail;

  let entries = detail.entries;
  let seeds = detail.seeds;
  let watches = detail.watches;
  let results = detail.results;

  for (const { write } of mine) {
    switch (write.kind) {
      case "entry": {
        const current = entries[write.eventId] ?? [];
        const next = write.entering
          ? current.includes(write.athleteId)
            ? current
            : [...current, write.athleteId]
          : current.filter((id) => id !== write.athleteId);
        entries = { ...entries, [write.eventId]: next };
        break;
      }

      case "seed": {
        // Nobody swims an event twice, so vacate whatever other lane they
        // held — the same rule `setSeed` applies on the server.
        seeds = seeds.filter(
          (s) =>
            !(
              s.eventId === write.eventId &&
              s.athleteId === write.athleteId &&
              !(s.heat === write.heat && s.lane === write.lane)
            ),
        );
        const at = seeds.findIndex(
          (s) =>
            s.eventId === write.eventId &&
            s.heat === write.heat &&
            s.lane === write.lane,
        );
        const next = {
          id: at >= 0 ? seeds[at].id : write.seedId,
          meetId: write.meetId,
          eventId: write.eventId,
          heat: write.heat,
          lane: write.lane,
          athleteId: write.athleteId,
        };
        seeds = at >= 0 ? seeds.map((s, i) => (i === at ? next : s)) : [...seeds, next];

        // Swimming a race is being in it.
        const current = entries[write.eventId] ?? [];
        if (!current.includes(write.athleteId)) {
          entries = { ...entries, [write.eventId]: [...current, write.athleteId] };
        }
        break;
      }

      case "unseed":
        seeds = seeds.filter((s) => s.id !== write.seedId);
        watches = watches.filter((w) => w.seedId !== write.seedId);
        results = results.filter((r) => r.seedId !== write.seedId);
        break;

      case "watch": {
        const existing = watches.find(
          (w) => w.seedId === write.seedId && w.timerId === write.timerId,
        );
        const next: Watch = {
          seedId: write.seedId,
          timerId: write.timerId,
          userId: write.userId,
          role: write.role,
          // A start that follows a time must not blank it — the same
          // `COALESCE` the server writes.
          timeMs: write.timeMs ?? existing?.timeMs,
          recordedAt: write.recordedAt,
          startedAt: write.startedAt ?? existing?.startedAt,
          stoppedAt: write.stoppedAt ?? existing?.stoppedAt,
        };
        watches = [
          ...watches.filter(
            (w) => !(w.seedId === next.seedId && w.timerId === next.timerId),
          ),
          next,
        ];
        break;
      }

      case "drop-watch":
        watches = watches.filter(
          (w) => !(w.seedId === write.seedId && w.timerId === write.timerId),
        );
        break;

      case "result": {
        const seed = seeds.find((s) => s.id === write.seedId);
        if (!seed) break;
        results = [
          ...results.filter((r) => r.seedId !== write.seedId),
          {
            seedId: write.seedId,
            meetId: write.meetId,
            eventId: seed.eventId,
            athleteId: seed.athleteId,
            status: write.status,
            timeMs: write.timeMs,
            decidedAt: Date.now(),
          },
        ];
        break;
      }

      case "unresult":
        results = results.filter((r) => r.seedId !== write.seedId);
        break;
    }
  }

  return { ...detail, entries, seeds, watches, results };
}

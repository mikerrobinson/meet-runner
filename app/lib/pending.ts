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
  let heats = detail.heats;
  let watches = detail.watches;
  let calls = detail.calls;

  const editHeat = (heatId: string, edit: (lanes: (string | null)[]) => void) => {
    heats = heats.map((heat) => {
      if (heat.id !== heatId) return heat;
      const lanes = [...heat.lanes];
      edit(lanes);
      return { ...heat, lanes };
    });
  };

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

      case "seat": {
        const heat = heats.find((h) => h.id === write.heatId);
        if (!heat) break;
        // Nobody swims an event twice, so vacate whatever lane they held —
        // the same rule `setSeat` applies on the server.
        for (const other of heats.filter((h) => h.eventId === heat.eventId)) {
          editHeat(other.id, (lanes) => {
            for (let i = 0; i < lanes.length; i++) {
              if (lanes[i] === write.athleteId) lanes[i] = null;
            }
          });
        }
        editHeat(write.heatId, (lanes) => {
          lanes[write.lane - 1] = write.athleteId;
        });
        // Swimming a race is being in it.
        const current = entries[heat.eventId] ?? [];
        if (!current.includes(write.athleteId)) {
          entries = { ...entries, [heat.eventId]: [...current, write.athleteId] };
        }
        break;
      }

      case "unseat":
        editHeat(write.heatId, (lanes) => {
          lanes[write.lane - 1] = null;
        });
        break;

      case "watch": {
        const next: Watch = {
          heatId: write.heatId,
          lane: write.lane,
          timerId: write.timerId,
          userId: write.userId,
          role: write.role,
          timeMs: write.timeMs,
          recordedAt: write.recordedAt,
          startedAt: write.startedAt,
          stoppedAt: write.stoppedAt,
        };
        watches = [
          ...watches.filter(
            (w) =>
              !(
                w.heatId === next.heatId &&
                w.lane === next.lane &&
                w.timerId === next.timerId
              ),
          ),
          next,
        ];
        break;
      }

      case "drop-watch":
        watches = watches.filter(
          (w) =>
            !(
              w.heatId === write.heatId &&
              w.lane === write.lane &&
              w.timerId === write.timerId
            ),
        );
        break;

      case "clear-watches":
        watches = watches.filter(
          (w) => !(w.heatId === write.heatId && w.timerId === write.timerId),
        );
        break;

      case "call": {
        const existing = calls.find(
          (c) => c.heatId === write.heatId && c.lane === write.lane,
        );
        calls = [
          ...calls.filter(
            (c) => !(c.heatId === write.heatId && c.lane === write.lane),
          ),
          {
            heatId: write.heatId,
            lane: write.lane,
            status: write.status ?? existing?.status ?? "OK",
            timeMs:
              write.timeMs === null ? undefined : (write.timeMs ?? existing?.timeMs),
            athleteId:
              write.athleteId === null
                ? undefined
                : (write.athleteId ?? existing?.athleteId),
            final: write.final ?? existing?.final ?? false,
            decidedAt: Date.now(),
            fromWatches: existing?.fromWatches,
          },
        ];
        break;
      }

      case "uncall":
        calls = calls.filter(
          (c) => !(c.heatId === write.heatId && c.lane === write.lane),
        );
        break;
    }
  }

  return { ...detail, entries, heats, watches, calls };
}

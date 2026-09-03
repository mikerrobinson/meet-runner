import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/meets";
import {
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Select,
  Sheet,
  TextInput,
} from "~/components/ui";
import { DUAL_MEET_EVENT_COUNT, defaultEvents } from "~/lib/events";
import { useAppStore } from "~/state/app-store";
import {
  MEET_TYPES,
  meetSubtitle,
  type MeetDoc,
  type MeetType,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meets · Meet Runner" }];
}

export default function Meets() {
  const { meets, createMeet } = useAppStore();
  const [adding, setAdding] = useState(false);

  // Newest first — during the season you're nearly always after the next one
  // or the one you just ran.
  const ordered = useMemo(
    () => [...meets].sort((a, b) => b.date.localeCompare(a.date)),
    [meets],
  );

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              + Meet
            </Button>
          }
        >
          Schedule ({meets.length})
        </SectionTitle>

        {meets.length === 0 ? (
          <EmptyState title="No meets yet">
            Add one to set up events, register swimmers, and run it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {ordered.map((meet) => (
              <li key={meet.id}>
                <Link
                  to={`/meets/${meet.id}`}
                  className="flex min-h-16 touch-manipulation items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {meet.name}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {meet.date} · {meetSubtitle(meet)}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {summarize(meet)}
                    </span>
                  </span>
                  <span aria-hidden className="text-xl text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adding && (
        <NewMeetSheet
          onClose={() => setAdding(false)}
          onCreate={(patch) => createMeet(patch)}
        />
      )}
    </div>
  );
}

function summarize(meet: MeetDoc): string {
  const entries = Object.values(meet.entries).reduce(
    (total, ids) => total + ids.length,
    0,
  );
  const parts = [
    `${meet.events.length} event${meet.events.length === 1 ? "" : "s"}`,
    `${entries} entr${entries === 1 ? "y" : "ies"}`,
  ];
  if (meet.results.length > 0) {
    parts.push(`${meet.results.length} time${meet.results.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function NewMeetSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (patch: Partial<MeetDoc>) => MeetDoc;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<MeetType>("dual");
  const [opponent, setOpponent] = useState("");
  const [withDefaults, setWithDefaults] = useState(true);

  const suggested =
    type === "intersquad"
      ? "Inter-squad"
      : opponent.trim()
        ? `vs ${opponent.trim()}`
        : "New Meet";

  const create = () => {
    const meet = onCreate({
      name: name.trim() || suggested,
      date,
      type,
      opponent: opponent.trim() || undefined,
      // Most meets swim the same lineup, so start from the standard order
      // rather than an empty setup screen.
      events: withDefaults ? defaultEvents("open") : [],
    });
    onClose();
    navigate(`/meets/${meet.id}/setup`);
  };

  return (
    <Sheet open title="New meet" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint={`Leave blank for "${suggested}".`}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested}
            autoCapitalize="words"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as MeetType)}
            >
              {MEET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {type !== "intersquad" && type !== "time-trial" && (
          <Field label="Opponent">
            <TextInput
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
              placeholder="Central High"
              autoCapitalize="words"
            />
          </Field>
        )}

        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            checked={withDefaults}
            onChange={(e) => setWithDefaults(e.target.checked)}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Start with the standard {DUAL_MEET_EVENT_COUNT}-event order
          </span>
        </label>

        <Button variant="primary" size="lg" full onClick={create}>
          Create meet
        </Button>
      </div>
    </Sheet>
  );
}

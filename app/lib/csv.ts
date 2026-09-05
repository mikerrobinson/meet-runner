import { generateId } from "./id";
import { formatTime } from "./time";
import { enrollmentFor, seasonForMeet } from "./roster";
import {
  eventName,
  swimmerName,
  type Gender,
  type MeetDoc,
  type Swimmer,
  type TeamDoc,
} from "~/types/meet";
import type { RosterEntry } from "~/state/app-store";

/** RFC-4180-ish parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel loves to add.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Header aliases, so a coach's export doesn't need renaming first. */
const COLUMN_ALIASES: Record<string, string[]> = {
  firstName: ["firstname", "first", "fname", "givenname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname"],
  fullName: ["name", "fullname", "swimmer", "swimmername", "athlete"],
  gender: ["gender", "sex", "m/f", "mf"],
  year: ["year", "schoolyear", "grade", "gradelevel", "class", "yr"],
  birthDate: [
    "birthdate",
    "birthday",
    "dob",
    "dateofbirth",
    "birth",
    "bday",
  ],
  squad: ["squad", "team", "side", "color", "group"],
};

function parseGender(value: string): Gender | null {
  const v = value.trim().toLowerCase();
  if (["m", "male", "b", "boy", "boys", "men"].includes(v)) return "M";
  if (["f", "female", "g", "girl", "girls", "w", "women"].includes(v)) return "F";
  return null;
}

/**
 * Read a birth date the way a coach's export actually writes it: ISO from a
 * database, or US m/d/y from a spreadsheet. Returns the ISO day, or the reason
 * it couldn't — a wrong birth date is worse than none, so anything ambiguous
 * or implausible is refused rather than guessed at. An empty cell is simply
 * absent, and reports an empty reason.
 */
export function parseBirthDate(
  value: string,
  today = new Date(),
): { date: string } | { error: string } {
  const text = value.trim();
  if (!text) return { error: "" };

  let year: number;
  let month: number;
  let day: number;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (slashed) {
    month = Number(slashed[1]);
    day = Number(slashed[2]);
    const rawYear = slashed[3];
    year = Number(rawYear);
    if (rawYear.length === 2) {
      // Two digits can't say which century. Nobody on a roster was born in
      // the future, so the recent past wins.
      const century = Math.floor(today.getFullYear() / 100) * 100;
      year = century + year;
      if (year > today.getFullYear()) year -= 100;
    }
  } else {
    return { error: `"${text}" isn't a date we recognise (try 2009-03-14 or 3/14/2009)` };
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { error: `"${text}" isn't a real date` };
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;

  // Round-tripping catches the 31st of February and friends.
  const check = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) {
    return { error: `"${text}" isn't a real date` };
  }
  if (year < 1900 || date > today.toISOString().slice(0, 10)) {
    return { error: `"${text}" is outside the range of a swimmer's birthday` };
  }

  return { date };
}

export interface RosterImport {
  entries: RosterEntry[];
  /** Human-readable problems, one per skipped or patched row. */
  warnings: string[];
}

/**
 * Turn a roster CSV into swimmers.
 *
 * Expects a header row. Name can arrive as separate first/last columns or as a
 * single "Name" column ("Last, First" or "First Last").
 */
export function parseRosterCsv(text: string): RosterImport {
  const rows = parseCsv(text);
  const warnings: string[] = [];

  if (rows.length === 0) {
    return { entries: [], warnings: ["The file was empty."] };
  }

  const header = rows[0].map(normalizeHeader);
  const column: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = header.findIndex((h) => aliases.includes(h));
    if (index >= 0) column[key] = index;
  }

  const hasName =
    column.fullName !== undefined ||
    column.firstName !== undefined ||
    column.lastName !== undefined;

  if (!hasName) {
    return {
      entries: [],
      warnings: [
        `No name column found. Expected a "First Name"/"Last Name" pair or a "Name" column. Found: ${rows[0].join(", ")}`,
      ],
    };
  }

  const cell = (row: string[], key: string) =>
    column[key] === undefined ? "" : (row[column[key]] ?? "").trim();

  const entries: RosterEntry[] = [];

  rows.slice(1).forEach((row, i) => {
    const lineNumber = i + 2;

    let firstName = cell(row, "firstName");
    let lastName = cell(row, "lastName");

    if (!firstName && !lastName) {
      const full = cell(row, "fullName");
      if (full.includes(",")) {
        const [last, first] = full.split(",");
        lastName = last.trim();
        firstName = (first ?? "").trim();
      } else {
        const parts = full.split(/\s+/).filter(Boolean);
        firstName = parts.slice(0, -1).join(" ");
        lastName = parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? "");
      }
    }

    if (!firstName && !lastName) {
      warnings.push(`Line ${lineNumber}: no name, skipped.`);
      return;
    }

    const rawGender = cell(row, "gender");
    const gender = parseGender(rawGender);
    if (!gender) {
      warnings.push(
        `Line ${lineNumber} (${firstName} ${lastName}): gender "${rawGender}" not recognized, defaulted to F.`,
      );
    }

    const rawBirthDate = cell(row, "birthDate");
    const birthDate = parseBirthDate(rawBirthDate);
    if ("error" in birthDate && birthDate.error) {
      warnings.push(
        `Line ${lineNumber} (${firstName} ${lastName}): ${birthDate.error}, left blank.`,
      );
    }

    entries.push({
      athlete: {
        id: generateId(),
        firstName,
        lastName,
        gender: gender ?? "F",
        birthDate: "date" in birthDate ? birthDate.date : undefined,
      },
      year: cell(row, "year"),
      squad: cell(row, "squad") || undefined,
    });
  });

  return { entries, warnings };
}

function csvEscape(value: string | number): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

/**
 * Results export: one row per recorded swim, ordered by event, then heat, then
 * finish place.
 */
export function resultsToCsv(meet: MeetDoc, team: TeamDoc): string {
  const swimmers = new Map(team.swimmers.map((s) => [s.id, s] as const));
  // Their year and squad as of this meet, not as of today.
  const seasonId = seasonForMeet(team, meet)?.id;
  const heats = new Map(meet.heats.map((h) => [h.id, h] as const));

  const rows: Array<Array<string | number>> = [
    [
      "Event #",
      "Event",
      "Heat",
      "Lane",
      "Swimmer",
      "Gender",
      "Year",
      "Squad",
      "Time",
      "Time (ms)",
      "Status",
      "Place",
      "Entry",
    ],
  ];

  meet.events.forEach((event, eventIndex) => {
    const eventResults = meet.results.filter((r) => r.eventId === event.id);

    // Place is scored across the whole event, not within a heat.
    const ranked = eventResults
      .filter((r) => r.status === "OK")
      .sort((a, b) => a.timeMs - b.timeMs);
    const place = new Map(ranked.map((r, i) => [r.id, i + 1] as const));

    const ordered = [...eventResults].sort((a, b) => {
      const heatDiff =
        (heats.get(a.heatId)?.index ?? 0) - (heats.get(b.heatId)?.index ?? 0);
      if (heatDiff !== 0) return heatDiff;
      return a.timeMs - b.timeMs;
    });

    for (const result of ordered) {
      const swimmer = swimmers.get(result.swimmerId);
      const enrolled = enrollmentFor(team, result.swimmerId, seasonId);
      rows.push([
        eventIndex + 1,
        eventName(event),
        (heats.get(result.heatId)?.index ?? 0) + 1,
        result.lane,
        swimmer ? swimmerName(swimmer) : "(unknown)",
        swimmer?.gender ?? "",
        enrolled?.year ?? "",
        enrolled?.squad ?? "",
        result.status === "OK" ? formatTime(result.timeMs) : result.status,
        result.status === "OK" ? result.timeMs : "",
        result.status,
        place.get(result.id) ?? "",
        result.manual ? "manual" : "stopwatch",
      ]);
    }
  });

  return toCsv(rows);
}

export function downloadFile(
  filename: string,
  contents: string,
  mimeType: string,
): void {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

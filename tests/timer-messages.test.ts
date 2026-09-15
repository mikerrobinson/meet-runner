import { done, eq } from "./harness.ts";
import {
  formatSeat,
  formatStart,
  formatSubmit,
  laneKey,
  parseLaneKey,
  parseSeat,
  parseStart,
  parseSubmit,
  splitTypedName,
} from "../app/lib/timer-messages.ts";

/* ------------------------------------------------- the addressing is the path */

eq(laneKey({ event: 7, heat: 1, lane: 3 }), "7/1/3", "a lane reads as event/heat/lane");
eq(parseLaneKey("7/1/3"), { event: 7, heat: 1, lane: 3 }, "and reads back");
eq(parseLaneKey("7/1"), null, "a partial address is not an address");
eq(parseLaneKey("0/1/3"), null, "these are 1-based, as the screen says them");
eq(parseLaneKey("x/1/3"), null, "and they are numbers");

/* ----------------------------------------------------------- round trips */

eq(
  parseSubmit(formatSubmit({ at: 1789413369235, elapsedMs: 30000 })),
  { at: 1789413369235, elapsedMs: 30000 },
  "a submitted time survives the round trip",
);
eq(
  parseStart(formatStart({ at: 1789413338262, startedAt: 1789413337235 })),
  { at: 1789413338262, startedAt: 1789413337235 },
  "so does a start",
);

// The format is positional and comma-delimited, so a name containing a comma
// — which is how this app writes them, "Castellanos, Sofia" — must not be
// able to shift every field after it.
const withComma = formatSeat({ at: 1, team: 0, athleteId: "", name: "Castellanos, Sofia" });
eq(withComma.split(",").length, 4, "an encoded name stays one field");
eq(parseSeat(withComma)?.name, "Castellanos, Sofia", "and comes back whole");

eq(
  parseSeat(formatSeat({ at: 5, team: 1, athleteId: "a-1", name: "" })),
  { at: 5, team: 1, athleteId: "a-1", name: "" },
  "a seat picked from the list carries an id and no name",
);

/* ------------------------------------------------------ refusing nonsense */

// A time nobody swam is not a time — the same rule the rest of the app keeps.
eq(parseSubmit("1789413369235,0"), null, "zero is not a time");
eq(parseSubmit("1789413369235,-5"), null, "nor is a clock that went backwards");
eq(parseSubmit("1789413369235"), null, "nor a message with no time in it");

eq(parseSeat("1789413328262,0,,"), null, "a seat naming nobody is not a seat");
eq(parseStart("1789413338262"), null, "a start with no timestamp is not a start");

// A message from a phone still running an older build should read as far as
// it makes sense rather than taking down the request that carried it.
eq(
  parseSubmit("1789413369235,30000,something,else"),
  { at: 1789413369235, elapsedMs: 30000 },
  "extra fields are ignored, not fatal",
);

/* ------------------------------------------------------------------ size */

// The whole reason for a positional format: it has to fit in a cookie, and a
// browser handed one over ~4KB drops it silently.
const anEvent =
  formatSeat({ at: 1789413328262, team: 1, athleteId: "", name: "Mike Robinson" }) +
  formatStart({ at: 1789413338262, startedAt: 1789413337235 }) +
  formatSubmit({ at: 1789413369235, elapsedMs: 30000 });
eq(anEvent.length < 200, true, `one lane's messages stay small (${anEvent.length} bytes)`);

/* ----------------------------------------------- names, in whichever order */

// What somebody types unprompted.
eq(splitTypedName("Mike Robinson"), { firstName: "Mike", lastName: "Robinson" }, "first last");
// What they copy off a heat sheet, or off this app's own surname-sorted
// roster column. Without the comma rule this lands as first name "Robinson,"
// — punctuation and all, in the wrong field, in front of the desk.
eq(splitTypedName("Robinson, Mike"), { firstName: "Mike", lastName: "Robinson" }, "last, first");
eq(splitTypedName("Castellanos,Sofia"), { firstName: "Sofia", lastName: "Castellanos" }, "no space after the comma");
eq(splitTypedName("  Ada   Lovelace  "), { firstName: "Ada", lastName: "Lovelace" }, "stray spaces collapse");
eq(splitTypedName("Prince"), { firstName: "Prince", lastName: "" }, "one name is a first name");
eq(splitTypedName("Mary Anne Evans"), { firstName: "Mary Anne", lastName: "Evans" }, "the surname is the last word");
eq(splitTypedName(""), { firstName: "", lastName: "" }, "nothing splits into nothing");

done();

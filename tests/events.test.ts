import { done, eq } from "./harness.ts";
import { RELAY_DISTANCES, convertDistances, defaultEvents, distancesFor, dualMeetRaceCount, standardOrder, withDiving, withoutDiving } from "../app/lib/events.ts";
import { eventName, isDiving } from "../app/types/meet.ts";
import { createMeetDoc } from "../app/lib/documents.ts";

/* --- course --- */
{
  const label = (o: Array<{ distance: number; stroke: string }>) =>
    o.map((e) => (e.stroke === "Diving" ? "Diving" : `${e.distance} ${e.stroke}`));

  eq(label(standardOrder("SCY")), [
    "200 Medley Relay", "200 Free", "200 IM", "50 Free", "Diving",
    "100 Fly", "100 Free", "500 Free", "200 Free Relay",
    "100 Back", "100 Breast", "400 Free Relay",
  ], "yards order keeps the 500");

  eq(label(standardOrder("LCM")), [
    "200 Medley Relay", "200 Free", "200 IM", "50 Free", "Diving",
    "100 Fly", "100 Free", "400 Free", "200 Free Relay",
    "100 Back", "100 Breast", "400 Free Relay",
  ], "metric order swims a 400 instead");

  eq(label(standardOrder("SCM")), label(standardOrder("LCM")), "both metric courses match");
  eq(standardOrder("SCY", false).length, 11, "diving still drops out");

  // The 400 free relay must not be mistaken for the 400 free.
  const lcm = standardOrder("LCM");
  eq(lcm.filter((e) => e.distance === 400).map((e) => e.stroke), ["Free", "Free Relay"], "only the distance free changes");

  eq(defaultEvents({ course: "LCM" }).map(eventName).slice(14, 16), ["Girls 400 Free", "Boys 400 Free"], "defaultEvents follows the course");
  eq(defaultEvents({ course: "SCY" }).map(eventName).slice(14, 16), ["Girls 500 Free", "Boys 500 Free"], "yards default unchanged");
  eq(defaultEvents().length, 24, "no-argument default is the yards split lineup");

  eq(distancesFor("SCY"), [25, 50, 100, 200, 500, 1000, 1650], "yards picker");
  eq(distancesFor("LCM"), [25, 50, 100, 200, 400, 800, 1500], "metric picker");
  eq(distancesFor("SCY").includes(400), false, "no 400 in a yards pool");
  eq(distancesFor("LCM").includes(500), false, "no 500 in a metric pool");
  eq(RELAY_DISTANCES, [100, 200, 400, 800], "relay distances are course-independent");
}

/* --- convert --- */
{
  const yards = defaultEvents({ course: "SCY" });
  const metric = convertDistances(yards, "SCY", "LCM");

  // The converted yards lineup should read exactly like a native metric one.
  eq(metric.map(eventName), defaultEvents({ course: "LCM" }).map(eventName), "converted lineup matches a native metric one");
  eq(metric.map((e) => e.id), yards.map((e) => e.id), "event ids survive, so entries and times do too");

  // Relays must not be dragged along: the 400 free relay stays 400.
  const relays = metric.filter((e) => e.stroke === "Free Relay").map((e) => e.distance);
  eq(relays, [200, 200, 400, 400], "relay distances untouched");

  // The three individual swaps, both ways.
  const long = [
    { id: "a", distance: 500, stroke: "Free", gender: "Open" },
    { id: "b", distance: 1000, stroke: "Free", gender: "Open" },
    { id: "c", distance: 1650, stroke: "Free", gender: "Open" },
    { id: "d", distance: 200, stroke: "IM", gender: "Open" },
    { id: "e", distance: 400, stroke: "Free Relay", gender: "Open" },
    { id: "f", distance: 1, stroke: "Diving", gender: "Open" },
  ] as const;

  eq(convertDistances([...long], "SCY", "SCM").map((e) => e.distance), [400, 800, 1500, 200, 400, 1], "yards to metres");
  eq(convertDistances(convertDistances([...long], "SCY", "LCM"), "LCM", "SCY").map((e) => e.distance), [500, 1000, 1650, 200, 400, 1], "and back again, unchanged");

  // Same measure: nothing moves, and it's the same array.
  const scm = convertDistances([...long], "LCM", "SCM");
  eq(scm.map((e) => e.distance), [500, 1000, 1650, 200, 400, 1], "LCM to SCM leaves distances alone");
  eq(convertDistances(yards, "SCY", "SCY") === yards, true, "a no-op returns the same array");

  // A distance with no counterpart is left as it is.
  eq(convertDistances([{ id: "g", distance: 800, stroke: "Free", gender: "Open" }] as never, "SCY", "LCM").map((e) => e.distance), [800], "an 800 in a yards meet stays an 800");

  // Girls' and boys' halves of a race must convert identically or the
  // registration grid would split them into two columns.
  const pairs = new Set(metric.filter((e) => e.stroke === "Free" && e.gender !== "Open").map((e) => `${e.distance}`));
  eq(convertDistances(defaultEvents({ course: "SCY" }), "SCY", "LCM").filter((e) => e.distance === 400 && e.stroke === "Free").length, 2, "both genders of the distance free convert together");
  eq(standardOrder("LCM").some((e) => e.distance === 500), false, "no 500 left anywhere in metric");
}

/* --- diving --- */
{
  eq(dualMeetRaceCount(true), 12, "12 races with diving");
  eq(dualMeetRaceCount(false), 11, "11 races without");

  const split = defaultEvents({ leadGender: "F", includeDiving: true });
  eq(split.length, 24, "split lineup is 24 events");
  eq(split.slice(6, 12).map(eventName), [
    "Girls 50 Free", "Boys 50 Free", "Girls Diving", "Boys Diving", "Girls 100 Fly", "Boys 100 Fly",
  ], "diving sits after the 50 free, girls first");

  const boysFirst = defaultEvents({ leadGender: "M", includeDiving: true });
  eq(boysFirst.slice(8, 10).map(eventName), ["Boys Diving", "Girls Diving"], "lead gender respected");

  const noDive = defaultEvents({ leadGender: "F", includeDiving: false });
  eq(noDive.length, 22, "22 events without diving");
  eq(noDive.some(isDiving), false, "no diving event");

  // Toggling on from a lineup that lacks it lands in the same place.
  eq(withDiving(noDive, "F").map(eventName), split.map(eventName), "withDiving matches the standard order");
  eq(withDiving(split, "F").length, 24, "adding twice is a no-op");
  eq(withoutDiving(split).map(eventName), noDive.map(eventName), "withoutDiving round-trips");

  // Open lineup gets a single Open event.
  const open = withDiving(defaultEvents({ mode: "open", includeDiving: false }), "F");
  eq(open.filter(isDiving).map(eventName), ["Diving"], "open lineup gets one Diving");

  // Empty lineup: gendered pair, appended.
  eq(withDiving([], "F").map(eventName), ["Girls Diving", "Boys Diving"], "empty lineup defaults to a pair");

  // A lineup with no 50 free puts diving at the end.
  const noFifty = defaultEvents({ mode: "open", includeDiving: false }).filter((e) => e.distance !== 50);
  eq(withDiving(noFifty, "F").at(-1)!.stroke, "Diving", "no 50 free -> appended");

  eq(createMeetDoc("t", { events: split }).options.includeDiving, true, "createMeetDoc infers on");
  eq(createMeetDoc("t", { events: [] }).options.includeDiving, false, "createMeetDoc infers off");
}

done();

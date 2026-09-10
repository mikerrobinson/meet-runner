import { done, eq } from "./harness.ts";
import { RELAY_DISTANCES, convertDistances, defaultEvents, distancesFor, dualMeetRaceCount, standardOrder, tallyEntries, teamFullFor, whyNotEnter, withDiving, withoutDiving } from "../app/lib/events.ts";
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

/* ----------------------------------------------------------- entry limits */

// NFHS caps a high-school swimmer at four events, at most two individual.
// The rules live on the meet because states vary and a time trial wants none.
{
  const events = defaultEvents({ course: "SCY" });
  const free50 = events.find((e) => e.distance === 50 && e.stroke === "Free")!;
  const free100 = events.find((e) => e.distance === 100 && e.stroke === "Free")!;
  const fly100 = events.find((e) => e.distance === 100 && e.stroke === "Fly")!;
  const relays = events.filter((e) => e.stroke.endsWith("Relay"));

  const meet = (entries: Record<string, string[]>, limits: any = {
    maxIndividual: 2, maxRelays: 2, maxTotal: 4,
  }) => ({
    events,
    entries,
    options: { laneCount: 6 as const, includeDiving: false, leadGender: "F" as const,
               limits, entryVisibility: "everyone" as const, athletesMayEnter: false },
  });

  eq(tallyEntries(meet({}), "a1"), { individual: 0, relay: 0, total: 0 }, "nobody starts entered");
  eq(whyNotEnter(meet({}), "a1", free50.id), null, "an empty card can enter anything");

  const twoIndividual = meet({ [free50.id]: ["a1"], [free100.id]: ["a1"] });
  eq(tallyEntries(twoIndividual, "a1").individual, 2, "two individual events");
  eq(
    whyNotEnter(twoIndividual, "a1", fly100.id),
    "Already in 2 individual events, and this meet allows 2.",
    "a third individual event is refused, and says why in words a coach can repeat",
  );
  eq(
    whyNotEnter(twoIndividual, "a1", relays[0].id),
    null,
    "but a relay is a different allowance",
  );

  // Re-checking an event they're already in must never report a breach, or a
  // full card couldn't be edited at all.
  eq(whyNotEnter(twoIndividual, "a1", free50.id), null, "an existing entry is always fine");

  const full = meet({
    [free50.id]: ["a1"], [free100.id]: ["a1"],
    [relays[0].id]: ["a1"], [relays[1].id]: ["a1"],
  });
  eq(tallyEntries(full, "a1"), { individual: 2, relay: 2, total: 4 }, "a full card");
  eq(whyNotEnter(full, "a1", fly100.id) !== null, true, "and nothing more fits");

  // No limits set is the time-trial case, and it means no limits.
  const open = meet({ [free50.id]: ["a1"], [free100.id]: ["a1"] }, {});
  eq(whyNotEnter(open, "a1", fly100.id), null, "a meet with no caps allows anything");

  // Diving holds a place in the running order but isn't a swim.
  const withDiving = defaultEvents({ course: "SCY", includeDiving: true });
  const diving = withDiving.find((e) => e.stroke === "Diving");
  if (diving) {
    const divers = {
      events: withDiving,
      entries: { [diving.id]: ["a1"] },
      options: { laneCount: 6 as const, includeDiving: true, leadGender: "F" as const,
                 limits: { maxTotal: 4 }, entryVisibility: "everyone" as const,
                 athletesMayEnter: false },
    };
    eq(tallyEntries(divers, "a1").total, 0, "diving doesn't count against a swimming cap");
  }

  /* ---- a team's allowance in one race ---- */
  const ours = new Set(["a1", "a2", "a3"]);
  const capped = meet({ [free50.id]: ["a1", "a2"] }, { maxPerTeamPerEvent: 2 });
  eq(teamFullFor(capped, free50.id, ours), true, "two of ours already in, and two is the cap");
  eq(teamFullFor(capped, free100.id, ours), false, "a different race has its own count");
  eq(
    teamFullFor(meet({ [free50.id]: ["a1", "a2"] }), free50.id, ours),
    false,
    "and with no per-team cap there's nothing to fill",
  );
  eq(
    teamFullFor(capped, free50.id, new Set(["b1"])),
    false,
    "another team's entries don't fill ours",
  );
}

done();

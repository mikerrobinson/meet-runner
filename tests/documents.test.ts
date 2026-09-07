import { done, eq } from "./harness.ts";
import { createMeetDoc, createTeam, normalizeAthlete, parseMeetDoc, parseTeamDoc, tombstone } from "../app/lib/documents.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { isDeleted } from "../app/types/meet.ts";
import { buildHeats } from "../app/lib/heats.ts";

/* --- meetdoc --- */
{
  const fresh = createMeetDoc("team1");
  eq(fresh.course, "SCY", "new meets default to SCY");
  eq(fresh.options.laneCount, 6, "new meets default to 6 lanes");
  eq("opponent" in fresh, false, "opponent is gone");
  eq(fresh.version, 7, "doc version bumped");
  eq(fresh.teamIds, ["team1"], "one team is still a list of teams");

  // Two schools, one meet — the shape the old model couldn't hold.
  const dual = createMeetDoc(["team1", "team2"], { hostTeamId: "team2" });
  eq(dual.teamIds, ["team1", "team2"], "a dual meet names both");
  eq(dual.hostTeamId, "team2", "and whose pool it is");
  eq("teamId" in dual, false, "no team owns it");

  // A host that isn't racing is a mistake, not a fact.
  const strayHost = parseMeetDoc({ id: "mh", teamIds: ["team1"], hostTeamId: "team9", events: [] })!;
  eq(strayHost.hostTeamId, undefined, "a host that isn't in the meet is dropped");

  // A partial options patch keeps the other defaults.
  const wide = createMeetDoc("team1", { options: { laneCount: 10 } });
  eq(wide.options, { laneCount: 10, leadGender: "F", includeDiving: false }, "partial options patch merges");

  // A document off the wire, with a field the model no longer has.
  const old = parseMeetDoc({
    id: "m1", teamId: "t1", name: "vs Central", date: "2026-09-03", type: "dual",
    course: "LCM", opponent: "Central High", location: "Cactus Aquatic Center",
    options: { laneCount: 8, laneLayout: "grid", leadGender: "M", includeDiving: true },
    events: [],
  })!;
  eq(old.course, "LCM", "course is read straight through");
  eq("opponent" in old, false, "opponent dropped on migration");
  eq(old.location, "Cactus Aquatic Center", "location survives");
  eq(old.options.laneCount, 8, "lane count survives");
  eq(old.name, "vs Central", "the name keeps whatever the opponent gave it");

  // Older still: no course at all, and a lane count that was never valid.
  const ancient = parseMeetDoc({ id: "m2", teamId: "t1", events: [], options: { laneCount: 7 } })!;
  eq(ancient.course, "SCY", "missing course defaults to SCY");
  eq(ancient.options.laneCount, 6, "bogus lane count falls back to 6");

  // Lane counts that are now legal must survive a round trip.
  for (const n of [4, 5, 6, 8, 10]) {
    const doc = parseMeetDoc({ id: "m3", teamId: "t1", events: [], options: { laneCount: n } })!;
    eq(doc.options.laneCount, n, `${n} lanes accepted`);
  }

  const junk = parseMeetDoc({ id: "m4", teamId: "t1", events: [], course: "SCM!" })!;
  eq(junk.course, "SCY", "an unknown course falls back to SCY");
}

/* --- tombstone --- */
{
  const events = defaultEvents({});
  const meet = createMeetDoc("team1", {
    name: "vs Central", date: "2026-09-05", course: "LCM", location: "Cactus",
    events,
    entries: { [events[0].id]: ["s1", "s2"] },
  });

  eq(isDeleted(meet), false, "a live meet isn't deleted");

  const dead = tombstone(meet);
  eq(dead.id, meet.id, "the tombstone keeps the id — that's the whole point");
  eq(dead.teamIds, meet.teamIds, "and the teams");
  eq(dead.name, meet.name, "and the name, so it can be reported");
  eq(dead.date, meet.date, "and the date");
  eq(isDeleted(dead), true, "and it reads as deleted");
  eq(dead.events.length, 0, "the lineup is dropped");
  eq(dead.watches.length, 0, "so are the times");
  eq(dead.rulings.length, 0, "and the rulings");
  eq(Object.keys(dead.entries).length, 0, "and the entries");
  eq(dead.updatedAt >= meet.updatedAt, true, "and is newer, so the deletion wins");

  // A tombstone has to survive the wire: it goes through parseMeetDoc on the server.
  const wired = parseMeetDoc(JSON.parse(JSON.stringify(dead)))!;
  eq(isDeleted(wired), true, "still deleted after a round trip");
  eq(wired.id, meet.id, "still the same meet");
  eq(wired.deletedAt, dead.deletedAt, "with the same timestamp");

  // And a live meet must never come back as deleted.
  const liveAgain = parseMeetDoc(JSON.parse(JSON.stringify(meet)))!;
  eq(liveAgain.deletedAt, undefined, "a live meet round-trips with no deletedAt at all");
  eq(isDeleted(liveAgain), false, "and reads that way");

  // Size: the point of emptying it is that the delete is cheap to send.
  const full = JSON.stringify(meet).length;
  const stone = JSON.stringify(dead).length;
  eq(stone < full / 4, true, `tombstone is a fraction of the document (${stone} vs ${full} bytes)`);
}

/* --- backup --- */
{
  // A season with every field populated, shaped exactly as the app stores it.
  const base = createTeam("Cactus Shadows");
  const seasonId = base.currentSeasonId;
  const athletes = [
    { id: "s1", firstName: "Avery", lastName: "Nguyen", gender: "F" as const, birthDate: "2009-03-14" },
    { id: "s2", firstName: "Marcus", lastName: "Hill", gender: "M" as const },
  ];
  const team = {
    ...base,
    code: "CHAP",
    enrollments: [
      { id: "e1", teamId: base.id, seasonId, athleteId: "s1", year: "10", squad: "Blue", status: "active" as const },
      { id: "e2", teamId: base.id, seasonId, athleteId: "s2", year: "12", status: "inactive" as const },
    ],
  };

  const events = defaultEvents({ course: "LCM" });
  const heats = buildHeats(events[2].id, ["s1", "s2"], 6);
  const meet = createMeetDoc(team.id, {
    name: "vs Central",
    date: "2026-09-05",
    type: "dual",
    course: "LCM",
    location: "Cactus Aquatic Center",
    options: { laneCount: 10, leadGender: "M", includeDiving: true },
    events,
    entries: { [events[2].id]: ["s1", "s2"] },
    heats,
    watches: [
      { id: `${heats[0].id}:5:timerA`, eventId: events[2].id, heatId: heats[0].id, lane: 5, timerId: "timerA", timeMs: 71270, recordedAt: 1757000000000, source: "stopwatch" as const },
      { id: `${heats[0].id}:5:timerB`, eventId: events[2].id, heatId: heats[0].id, lane: 5, timerId: "timerB", timeMs: 71310, recordedAt: 1757000000001, source: "typed" as const },
    ],
    rulings: [
      { id: `${heats[0].id}:6`, eventId: events[2].id, heatId: heats[0].id, lane: 6, status: "DQ" as const, decidedAt: 1757000000002 },
    ],
    progress: { eventIndex: 2, heatIndex: 0 },
    timer: null,
  });

  // What Settings > Export season writes, and what Import reads back. Athletes
  // travel alongside the teams now rather than inside one of them.
  const exported = JSON.parse(JSON.stringify({ kind: "meet-runner-backup", exportedAt: new Date().toISOString(), teams: [team], athletes, meets: [meet] }));
  const reimportedTeam = parseTeamDoc(exported.teams[0])!;
  const reimportedAthletes = exported.athletes.map(normalizeAthlete);
  const reimportedMeet = parseMeetDoc(exported.meets[0], reimportedTeam.id)!;

  eq(reimportedTeam, JSON.parse(JSON.stringify(team)), "team survives a round trip unchanged");
  eq(reimportedMeet, JSON.parse(JSON.stringify(meet)), "meet survives a round trip unchanged");

  // Second round trip: stable, not drifting.
  const again = parseMeetDoc(JSON.parse(JSON.stringify(reimportedMeet)))!;
  eq(again, reimportedMeet, "a second round trip changes nothing");

  // Compare what actually serializes: a key holding `undefined` is an absence,
  // not a field, and JSON drops it on the way to disk and the wire.
  const wireKeys = (v: unknown) => Object.keys(JSON.parse(JSON.stringify(v))).sort();
  eq(wireKeys(reimportedMeet), wireKeys(meet), "no meet field is dropped");
  eq(wireKeys(reimportedTeam), wireKeys(team), "no team field is dropped");
  eq(reimportedMeet.watches, meet.watches, "watches carry through verbatim");
  eq(reimportedMeet.rulings, meet.rulings, "rulings carry through verbatim");
  eq(reimportedMeet.watches.length, 2, "both timers' watches survive, not just one");
  eq(reimportedMeet.heats, meet.heats, "heats carry through verbatim");
  eq(reimportedMeet.entries, meet.entries, "entries carry through verbatim");
  eq(reimportedAthletes, JSON.parse(JSON.stringify(athletes)), "people carry through verbatim");
  eq(reimportedAthletes[0].birthDate, "2009-03-14", "birth dates carry through");
  eq("athletes" in reimportedTeam, false, "and are not smuggled back into the team");
  eq(reimportedTeam.enrollments, JSON.parse(JSON.stringify(team.enrollments)), "enrollments carry through verbatim");
  eq(reimportedTeam.seasons, JSON.parse(JSON.stringify(team.seasons)), "seasons carry through verbatim");
  eq(reimportedTeam.code, "CHAP", "team code carries through");
  eq(reimportedTeam.currentSeasonId, seasonId, "the current season pointer survives");

  // What a document saved by YESTERDAY's build looks like coming back.
  const old = parseMeetDoc({
    id: "m-old", teamId: team.id, name: "vs Horizon", date: "2026-09-01", type: "dual",
    format: "SCY", opponent: "Horizon High", location: "Horizon",
    options: { laneCount: 6, laneLayout: "list-desc", leadGender: "F", includeDiving: false },
    events: [], entries: {}, heats: [], results: [], progress: { eventIndex: 0, heatIndex: 0 },
    timer: null, updatedAt: 1756000000000,
  })!;
  eq(old.course, "SCY", "old `format` is read as `course`");
  eq("opponent" in old, false, "`opponent` is dropped");
  eq("laneLayout" in old.options, false, "`laneLayout` is dropped");
  eq(old.name, "vs Horizon", "everything else is untouched");
  eq(old.updatedAt, 1756000000000, "updatedAt is preserved exactly");
}

done();

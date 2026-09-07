import { done, eq } from "./harness.ts";
import type { Athlete, Entries, Heat, TeamDoc, WatchTime } from "../app/types/meet.ts";
import {
  changedObjects,
  entryId,
  fromObjects,
  mergeObjects,
  referencedAthletes,
  scopeKey,
  toObjects,
} from "../app/lib/objects.ts";
import { createMeetDoc, createTeam, tombstone } from "../app/lib/documents.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { buildHeats } from "../app/lib/heats.ts";
import { makeEnrollment, makeSeason, rosterForMeetTeams, teamForAthleteAt } from "../app/lib/roster.ts";

/* --------------------------------------------------- two teams, one meet */

const base = createTeam("Cactus Shadows");
const s1 = makeSeason(base.id, "2026-27", { startDate: "2026-08-01", endDate: "2027-07-31" });
const home: TeamDoc = {
  ...base, code: "CHAP", headCoach: "M. Robinson", nameOrder: "first" as const,
  seasons: [s1], currentSeasonId: s1.id,
  enrollments: [
    makeEnrollment(base.id, s1.id, "a1", { year: "10", squad: "Blue" }),
    makeEnrollment(base.id, s1.id, "a2", { year: "12", status: "inactive" }),
  ],
  updatedAt: 1757000000000,
};

// The opponent. Unclaimed — nobody from Horizon has ever signed in — but a
// real team all the same, which is the whole point of the change.
const visitorBase = createTeam("Horizon");
const s2 = makeSeason(visitorBase.id, "2026-27", { startDate: "2026-08-01", endDate: "2027-07-31" });
const visitor: TeamDoc = {
  ...visitorBase, code: "HRZN", seasons: [s2], currentSeasonId: s2.id,
  enrollments: [makeEnrollment(visitorBase.id, s2.id, "a9", { year: "11" })],
  updatedAt: 1757000000000,
};

// People. They belong to no team; the enrollments above say who swims for whom.
const athletes: Athlete[] = [
  { id: "a1", firstName: "Avery", lastName: "Nguyen", gender: "F", birthDate: "2009-03-14" },
  { id: "a2", firstName: "Marcus", lastName: "Hill", gender: "M" },
  { id: "a9", firstName: "Dana", lastName: "Reyes", gender: "F", userId: "u7" },
];

const events = defaultEvents({ course: "SCY" });
const heats = buildHeats(events[2].id, ["a1", "a2"], 6);
const meet = createMeetDoc([home.id, visitor.id], {
  name: "vs Horizon", date: "2026-11-14", course: "SCY", location: "Cactus Aquatic Center",
  hostTeamId: home.id, createdBy: "u1",
  options: { laneCount: 8, leadGender: "M" },
  events,
  entries: { [events[2].id]: ["a1", "a2"], [events[3].id]: ["a2"] },
  heats,
  watches: [
    { id: `${heats[0].id}:3:tA`, eventId: events[2].id, heatId: heats[0].id, lane: 3, timerId: "tA", timeMs: 71270, recordedAt: 1757000000005, source: "stopwatch" },
    { id: `${heats[0].id}:3:tB`, eventId: events[2].id, heatId: heats[0].id, lane: 3, timerId: "tB", timeMs: 71310, recordedAt: 1757000000006, source: "typed" },
    // A timer saying the lane held someone other than the lineup's swimmer.
    { id: `${heats[0].id}:6:tA`, eventId: events[2].id, heatId: heats[0].id, lane: 6, timerId: "tA", timeMs: 68120, recordedAt: 1757000000009, source: "stopwatch", athleteId: "a9", startedAt: 1757000000000, stoppedAt: 1757000068120 },
  ],
  rulings: [{ id: `${heats[0].id}:4`, eventId: events[2].id, heatId: heats[0].id, lane: 4, status: "DQ" as const, decidedAt: 1757000000007 }],
  timer: null, updatedAt: 1757000000100,
});
const dead = tombstone(createMeetDoc(home.id, { name: "Cancelled", date: "2026-12-01" }));

const teams = [home, visitor];

/* ---- scoping ---- */
const objects = toObjects(teams, athletes, [meet, dead]);
const scopeOf = (type: string) =>
  [...new Set(objects.filter((o) => o.type === type).map((o) => scopeKey(o.scope)))];

eq(scopeOf("season"), [`team:${home.id}`, `team:${visitor.id}`], "seasons belong to their team");
eq(scopeOf("athlete"), ["global"], "people belong to nobody");
eq(scopeOf("watch"), [`meet:${meet.id}`], "times belong to the meet, not to a team");
eq(scopeOf("heat"), [`meet:${meet.id}`], "so do heats");
eq(
  objects.some((o) => o.scope.kind === "meet" && o.scope.id === home.id),
  false,
  "nothing is scoped to a team by way of the meet it was created from",
);

/* ---- round trip ---- */
const back = fromObjects(objects);
const bh = back.teams.find((t) => t.id === home.id)!;
const bv = back.teams.find((t) => t.id === visitor.id)!;
eq(back.teams.length, 2, "both teams come back");
eq(bh.name, home.name, "team name");
eq(bh.code, "CHAP", "code");
eq(bh.headCoach, "M. Robinson", "head coach");
eq(bh.currentSeasonId, s1.id, "current season");
eq(bh.seasons, home.seasons, "seasons intact");
eq(bh.enrollments, home.enrollments, "enrollments intact");
eq(bv.enrollments.length, 1, "the opponent's roster stays the opponent's");
eq("athletes" in bh, false, "a team no longer carries people");
eq(back.athletes, athletes, "people come back once, not once per team");
eq(back.athletes.find((a) => a.id === "a9")?.userId, "u7", "an athlete's account link survives");

const bm = back.meets.find((m) => m.id === meet.id)!;
eq(bm.name, meet.name, "meet name");
eq(bm.teamIds, [home.id, visitor.id], "a meet references both teams");
eq(bm.hostTeamId, home.id, "and knows whose pool it is");
eq(bm.createdBy, "u1", "and who set it up");
eq(bm.location, meet.location, "location");
eq(bm.options, meet.options, "options");
eq(bm.events, meet.events, "lineup keeps its order");
eq(bm.entries, meet.entries, "entries intact");
eq(bm.heats, meet.heats, "heats intact");
eq(bm.watches, meet.watches, "every timer's watch intact");
eq(
  bm.watches.find((w) => w.lane === 6)?.athleteId,
  "a9",
  "a timer's correction rides on the watch, not the lineup",
);
eq(bm.heats, meet.heats, "and the lineup itself is untouched by it");
eq(bm.watches.find((w) => w.lane === 6)?.startedAt, 1757000000000, "start/stop timestamps survive");
eq(bm.rulings, meet.rulings, "rulings intact");
eq(back.meets.some((m) => m.id === dead.id), false, "a deleted meet doesn't come back live");
eq(objects.filter((o) => o.id === dead.id && o.deletedAt).length, 1, "its tombstone is in the set");
eq(objects.some((o) => JSON.stringify(o.data).includes("eventIndex")), false, "progress never leaves the device");

// The composite key matters: meet and lineup share an id on purpose.
const sharedId = objects.filter((o) => o.id === meet.id).map((o) => o.type).sort();
eq(sharedId, ["lineup", "meet"], "meet and lineup share an id, so (type,id) is the key");

/* ---- who swims for whom, derived rather than stored ---- */
eq(teamForAthleteAt(teams, meet, "a1")?.id, home.id, "our swimmer scores for us");
eq(teamForAthleteAt(teams, meet, "a9")?.id, visitor.id, "theirs scores for them");
eq(teamForAthleteAt(teams, meet, "nobody"), null, "an unaffiliated entry belongs to neither");
eq(
  rosterForMeetTeams(athletes, teams, meet).map((a) => a.id),
  ["a1", "a9"],
  "the heat sheet is everyone racing, from either team — an inactive enrollment is off it",
);

/* ---- the participant projection ---- */
const meetOnly = objects.filter((o) => o.scope.kind === "meet" && o.scope.id === meet.id);
eq(
  [...referencedAthletes(meetOnly)].sort(),
  ["a1", "a2", "a9"],
  "one meet's objects name exactly the people a device working it needs",
);

/* ---- diffing ---- */
const before = toObjects(teams, athletes, [meet]);
const withWatch = { ...meet, watches: [...meet.watches, { id: `${heats[0].id}:5:tC`, eventId: events[2].id, heatId: heats[0].id, lane: 5, timerId: "tC", timeMs: 69990, recordedAt: 1757000000008, source: "stopwatch" as const }], updatedAt: Date.now() };
const oneWatch = changedObjects(before, toObjects(teams, athletes, [withWatch]));
eq(oneWatch.length, 1, "adding a watch sends exactly one object");
eq(oneWatch[0].type, "watch", "and it's the watch");

const morePeople = [...athletes, { id: "a3", firstName: "Jo", lastName: "Park", gender: "F" as const }];
const oneAthlete = changedObjects(before, toObjects(teams, morePeople, [meet]));
eq(oneAthlete.length, 1, "adding a swimmer sends exactly one object");
eq(oneAthlete[0].type, "athlete", "and it's the athlete");
eq(scopeKey(oneAthlete[0].scope), "global", "scoped to nobody");

const lessEntry = { ...meet, entries: { ...meet.entries, [events[2].id]: ["a1"] }, updatedAt: Date.now() };
const removed = changedObjects(before, toObjects(teams, athletes, [lessEntry]));
eq(removed.length, 1, "un-entering sends one object");
eq(removed[0].id, entryId(meet.id, events[2].id, "a2"), "the right entry");
eq(removed[0].deletedAt !== undefined, true, "marked deleted");

eq(changedObjects(before, toObjects(teams, athletes, [meet])), [], "an unchanged season sends nothing");

// The property is that a push is the size of the *change*, not of the
// document — so it stays flat as a meet fills up over an afternoon.
const oneWatchBytes = JSON.stringify(oneWatch).length;
eq(oneWatchBytes < 700, true, `one watch is a few hundred bytes (${oneWatchBytes})`);

// A meet as it looks near the end: every event entered, heats seeded, three
// timers on every lane.
const bigEntries: Entries = {};
const bigHeats: Heat[] = [];
const bigWatches: WatchTime[] = [];
for (const event of events) {
  bigEntries[event.id] = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const h = { id: `h-${event.id}`, eventId: event.id, index: 0, lanes: ["a1","a2","a3","a4","a5","a6"] };
  bigHeats.push(h);
  for (let lane = 1; lane <= 6; lane++) {
    for (const t of ["tA", "tB", "tC"]) {
      bigWatches.push({ id: `${h.id}:${lane}:${t}`, eventId: event.id, heatId: h.id, lane, timerId: t, timeMs: 30000 + lane * 7, recordedAt: 1757000000000, source: "stopwatch" as const });
    }
  }
}
const bigMeet = { ...meet, entries: bigEntries, heats: bigHeats, watches: bigWatches, updatedAt: Date.now() };
const bigBefore = toObjects(teams, athletes, [bigMeet]);
const oneMore = { ...bigMeet, watches: [...bigWatches, { id: "extra", eventId: events[0].id, heatId: bigHeats[0].id, lane: 1, timerId: "tD", timeMs: 30123, recordedAt: 1757000000009, source: "stopwatch" as const }], updatedAt: Date.now() };
const delta = JSON.stringify(changedObjects(bigBefore, toObjects(teams, athletes, [oneMore]))).length;
const fullMeet = JSON.stringify(bigMeet).length;
eq(delta < 700, true, `the same watch on a full meet is still a few hundred bytes (${delta} vs ${fullMeet} for the whole meet)`);
eq(fullMeet > 100000, true, `a full meet really is large (${Math.round(fullMeet / 1024)}KB)`);
eq(bigWatches.length, 432, "432 watches in a 24-event meet with three timers a lane");

/* ---- merging: two devices, different objects ---- */
const laptop = changedObjects(before, toObjects(teams, morePeople, [meet]), 2000);
const ipad = changedObjects(before, toObjects(teams, athletes, [withWatch]), 2000);
const both = fromObjects(mergeObjects(mergeObjects(before, laptop), ipad));
eq(both.athletes.length, athletes.length + 1, "the laptop's swimmer survives");
eq(
  both.meets[0].watches.length,
  meet.watches.length + 1,
  "and the iPad's watch does too",
);

// The case the old model couldn't express: two schools editing one meet.
const theirEntry = { ...meet, entries: { ...meet.entries, [events[4].id]: ["a9"] }, updatedAt: 3000 };
const ourEntry = { ...meet, entries: { ...meet.entries, [events[5].id]: ["a1"] }, updatedAt: 3000 };
const theirs = changedObjects(before, toObjects(teams, athletes, [theirEntry]), 3000);
const ours = changedObjects(before, toObjects(teams, athletes, [ourEntry]), 3000);
const shared = fromObjects(mergeObjects(mergeObjects(before, theirs), ours)).meets[0];
eq(shared.entries[events[4].id], ["a9"], "the visiting coach's entry lands");
eq(shared.entries[events[5].id], ["a1"], "and ours does too, in the same meet");

const older = { ...before[0], data: { ...(before[0].data as object), name: "Older" }, updatedAt: 1 };
const newer = { ...before[0], data: { ...(before[0].data as object), name: "Newer" }, updatedAt: 9 };
eq((mergeObjects([older], [newer])[0].data as { name: string }).name, "Newer", "newer wins");
eq((mergeObjects([newer], [older])[0].data as { name: string }).name, "Newer", "an older arrival is ignored");

/* ---- the dangerous case: absence must not be read as deletion by accident ---- */
// A meet the device still holds, tombstoned locally, should delete its parts.
const withTomb = tombstone(meet);
const deleteAt = Date.now();
const afterDelete = changedObjects(before, toObjects(teams, athletes, [withTomb]), deleteAt);
const deletedTypes = [...new Set(afterDelete.filter((o) => o.deletedAt).map((o) => o.type))].sort();
eq(deletedTypes, ["entry", "heat", "lineup", "meet", "ruling", "watch"], "deleting a meet takes its parts with it");
eq(
  afterDelete.some((o) => o.type === "athlete"),
  false,
  "and takes nobody with it — people outlive the meets they swam",
);

// A deletion has to be newer than what it deletes, or the merge discards it.
// True of any real clock, and worth saying out loud rather than relying on.
eq(afterDelete.every((o) => o.updatedAt >= deleteAt || !o.deletedAt), true, "deletions carry the time they were made");
const stale = changedObjects(before, toObjects(teams, athletes, [withTomb]), 1);
eq(mergeObjects(before, stale).some((o) => o.type === "watch" && o.deletedAt), false, "a deletion older than the object loses, as last-write-wins requires");

// Already-deleted objects are not re-deleted on every sync.
const settled = mergeObjects(before, afterDelete);
eq(changedObjects(settled, toObjects(teams, athletes, [withTomb])), [], "a settled deletion stays quiet");

done();

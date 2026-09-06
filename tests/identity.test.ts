import { done, eq } from "./harness.ts";
import {
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  canAdmit,
  checkChallenge,
  formatContact,
  maskContact,
  newCode,
  normalizeCode,
  normalizePhone,
  parseContact,
  teamToOpen,
  timingSafeEqual,
  type Membership,
} from "../app/lib/identity.ts";

/* ---------------------------------------------------------------- contacts */

// The property that matters: two people typing the same contact different ways
// must land on the same stored string, or one person becomes two accounts.
const same = (a: string, b: string) => {
  const x = parseContact(a);
  const y = parseContact(b);
  return x.ok && y.ok && x.contact.value === y.contact.value;
};

eq(same("Coach@School.ORG", "  coach@school.org "), true, "email case and space don't matter");
eq(same("(480) 555-0134", "480-555-0134"), true, "phone punctuation doesn't matter");
eq(same("4805550134", "+1 480 555 0134"), true, "a bare US number is the +1 one");
eq(same("14805550134", "+14805550134"), true, "a leading 1 is the country code");
eq(same("coach@school.org", "coach@other.org"), false, "different addresses stay different");

{
  const parsed = parseContact("coach@school.org");
  eq(parsed.ok && parsed.contact.kind, "email", "an @ means email");
}
{
  const parsed = parseContact("480-555-0134");
  eq(parsed.ok && parsed.contact.kind, "phone", "digits mean phone");
  eq(parsed.ok && parsed.contact.value, "+14805550134", "stored in E.164");
}

eq(parseContact("").ok, false, "empty is not a contact");
eq(parseContact("   ").ok, false, "nor is whitespace");
eq(parseContact("coach@school").ok, false, "an address needs a dot in the domain");
eq(parseContact("coach at school dot org").ok, false, "prose is not a contact");
eq(parseContact("12345").ok, false, "a short number isn't a phone");

// Anything that isn't ten digits has to say its country, because guessing one
// is how a code goes somewhere it can't be read.
eq(normalizePhone("+447700900123"), "+447700900123", "an explicit country code is kept");
eq(normalizePhone("447700900123"), null, "the same digits without a + are refused");
eq(normalizePhone("+1234567"), null, "too short even with a +");
eq(normalizePhone(""), null, "nothing is not a number");

eq(formatContact({ kind: "phone", value: "+14805550134" }), "(480) 555-0134", "US numbers read normally");
eq(formatContact({ kind: "phone", value: "+447700900123" }), "+447700900123", "others are left alone");

// A mask has to be enough to recognise your own contact and not enough to
// learn someone else's.
{
  const masked = maskContact({ kind: "email", value: "coach@school.org" });
  eq(masked, "co•••@school.org", "email keeps two letters and the domain");
  eq(masked.includes("coach"), false, "the local part isn't given away");
}
eq(maskContact({ kind: "phone", value: "+14805550134" }), "•••••0134", "phone keeps four digits");

/* ------------------------------------------------------------------- codes */

{
  // Leading zeros are real codes: a generator that dropped them would produce
  // strings people can't type back.
  const codes = Array.from({ length: 400 }, () => newCode());
  eq(codes.every((c) => c.length === CODE_LENGTH), true, "every code is six digits");
  eq(codes.every((c) => /^\d+$/.test(c)), true, "and only digits");
  eq(new Set(codes).size > 350, true, `codes don't repeat much (${new Set(codes).size}/400 distinct)`);
}

eq(normalizeCode("123 456"), "123456", "a pasted code with spaces still works");
eq(normalizeCode("123-456"), "123456", "and with punctuation");
eq(normalizeCode("1234567890"), "123456", "extra digits are ignored, not appended");

eq(timingSafeEqual("123456", "123456"), true, "equal strings compare equal");
eq(timingSafeEqual("123456", "123457"), false, "one digit out is not equal");
eq(timingSafeEqual("123456", "12345"), false, "a prefix is not equal");
eq(timingSafeEqual("", ""), true, "two nothings are equal");

/* --------------------------------------------------------------- challenge */

const t0 = 1_760_000_000_000;
const fresh = { createdAt: t0, attempts: 0 };

eq(checkChallenge(fresh, true, t0 + 1000), { ok: true }, "the right code, in time, works");
eq(checkChallenge(fresh, false, t0 + 1000).ok, false, "the wrong code doesn't");
eq(
  checkChallenge(fresh, false, t0 + 1000),
  { ok: false, reason: "wrong" },
  "and says so",
);

// Order matters. A burnt challenge must say it's burnt even when the code
// being typed is the right one, or someone retypes a correct code forever.
eq(
  checkChallenge(fresh, true, t0 + CODE_TTL_MS + 1),
  { ok: false, reason: "expired" },
  "an expired code is expired, not wrong",
);
eq(
  checkChallenge({ createdAt: t0, attempts: MAX_ATTEMPTS }, true, t0 + 1000),
  { ok: false, reason: "exhausted" },
  "a spent challenge is spent, not wrong",
);
eq(
  checkChallenge({ createdAt: t0, attempts: MAX_ATTEMPTS }, true, t0 + CODE_TTL_MS + 1),
  { ok: false, reason: "expired" },
  "expiry is reported ahead of exhaustion",
);
eq(
  checkChallenge(fresh, true, t0 + CODE_TTL_MS - 1),
  { ok: true },
  "a code is good right up to the deadline",
);
eq(
  checkChallenge({ createdAt: t0, attempts: MAX_ATTEMPTS - 1 }, true, t0 + 1),
  { ok: true },
  "the last permitted attempt still counts",
);

/* ------------------------------------------------------------------- roles */

const active = (role: Membership["role"]): Membership => ({
  teamId: "t1",
  role,
  status: "active",
});

eq(canAdmit(active("head_coach")), true, "a head coach can let people in");
eq(canAdmit(active("coach")), true, "so can a coach");
eq(canAdmit(active("athlete")), false, "an athlete can't");
eq(canAdmit(active("parent")), false, "nor a parent");
eq(canAdmit(active("viewer")), false, "nor a viewer");
eq(canAdmit(undefined), false, "nor someone who isn't on the team at all");

// The one that would actually hurt: a request that hasn't been approved yet
// must not carry the powers of the role it asked for.
eq(
  canAdmit({ teamId: "t1", role: "head_coach", status: "pending" }),
  false,
  "a pending head coach can do nothing yet",
);

/* --------------------------------------------------------- which team opens */

const memberships: Membership[] = [
  { teamId: "chap", role: "head_coach", status: "active" },
  { teamId: "horizon", role: "coach", status: "active" },
  { teamId: "central", role: "viewer", status: "pending" },
];

eq(teamToOpen(memberships, {}), "chap", "with nothing else to go on, the first team");
eq(
  teamToOpen(memberships, { lastTeamId: "horizon" }),
  "horizon",
  "where they were last beats the first",
);
eq(
  teamToOpen(memberships, { lastTeamId: "horizon", invitedTeamId: "chap" }),
  "chap",
  "an invitation they just followed beats where they were",
);
eq(
  teamToOpen(memberships, { lastTeamId: "gone" }),
  "chap",
  "a team they've been removed from is ignored",
);
eq(
  teamToOpen(memberships, { invitedTeamId: "central" }),
  "chap",
  "an invite to a team still pending approval doesn't open it",
);
eq(teamToOpen([], {}), null, "somebody with no teams has nothing to open");
eq(
  teamToOpen([{ teamId: "central", role: "viewer", status: "pending" }], {}),
  null,
  "and a pending request is not a team you're on",
);

done();

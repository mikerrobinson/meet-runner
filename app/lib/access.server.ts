/**
 * What the person asking may do here.
 *
 * Worked out in the loader, beside the rows it guards, and handed to the
 * screen as part of its data. That placement is the whole point: permission
 * used to be a separate round trip to `/api/meets/:id/me`, answered from the
 * server's copy of a meet while the screen rendered from the device's copy —
 * so a meet you had created but not yet synced came back "you are not its
 * administrator", and the editing controls vanished from your own meet.
 *
 * One query, one answer, same transaction as the data. It cannot disagree with
 * what's on screen, and there is no failure mode where it silently falls back
 * to read-only.
 */

import { ensureSchema } from "./schema.server";
import { isMeetAdmin } from "./admins.server";
import { membershipsFor } from "./auth.server";
import { isCoach, type Role } from "./identity";
import { ANONYMOUS, type MeetAccess, type TeamAccess } from "./access";
import type { User } from "./auth.server";

export * from "./access";

export async function meetAccess(
  db: D1Database,
  meetId: string,
  user: User | null,
): Promise<MeetAccess> {
  if (!user) return ANONYMOUS;
  await ensureSchema(db);

  const [admin, memberships, racing, mine] = await Promise.all([
    isMeetAdmin(db, user.id, meetId),
    membershipsFor(db, user.id),
    db.prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?")
      .bind(meetId)
      .all<{ team_id: string }>(),
    db.prepare("SELECT id FROM athletes WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>(),
  ]);

  const teamIds = new Set(racing.results.map((r) => r.team_id));
  return {
    signedIn: true,
    userId: user.id,
    admin,
    coachOf: memberships
      .filter(
        (m) =>
          m.status === "active" && isCoach(m.role as Role) && teamIds.has(m.teamId),
      )
      .map((m) => m.teamId),
    athleteId: mine?.id ?? null,
  };
}

/* ----------------------------------------------------------------- teams */

export async function teamAccess(
  db: D1Database,
  teamId: string,
  user: User | null,
): Promise<TeamAccess> {
  if (!user) return { signedIn: false, userId: null, coach: false, member: false };
  const memberships = await membershipsFor(db, user.id);
  const mine = memberships.find((m) => m.teamId === teamId && m.status === "active");
  return {
    signedIn: true,
    userId: user.id,
    coach: mine ? isCoach(mine.role as Role) : false,
    member: mine !== undefined,
  };
}

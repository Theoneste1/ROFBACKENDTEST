/**
 * Who may view a COACH's or a HEAD COACH's profile — and so their picture (owner 2026-11-27: "a user's profile picture
 * must be visible to everyone who has permission to view that user's profile"). There is no separate profile page for
 * them; their name and picture reach other people only through these existing permissions, which this rule reuses:
 *  - the person themself;
 *  - Administrators and Super Administrators (they manage every account, and alone list a programme's heads);
 *  - for a COACH only: the Head Coaches of a programme the coach belongs to (AccessService.programmeScope — the scope Head
 *    Coaches already use to manage their programme's coaches). Nobody but Administrators manages a Head Coach;
 *  - anyone who may read a course discussion the person takes part in: for each (course, division) they work in
 *    (AccessService.courseScopes: a Coach's assignments and programme courses, a Head Coach's assignments),
 *    AccessService.assertCanView — the very check of the discussions — decides. In practice: the students of that
 *    division in that course, and the coaches and Head Coaches working there;
 *  - anyone else (Teachers, students of other divisions, coaches elsewhere, another programme's Head Coach, an
 *    unsupported role): no — the same 404 as "no picture" (AvatarService.send), so the answer never reveals whether the
 *    person has one.
 */
import { HttpException, Injectable } from '@nestjs/common';

import { APP_ROLES } from '../auth/permissions.js';
import { AccessService } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isHeadCoach } from '../common/access/roles.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CoachProfileService {
  constructor(private readonly prisma: PrismaService, private readonly access: AccessService) {}

  /** Whether `viewer` may view this Coach's or Head Coach's profile and picture (see the file header). */
  async mayView(viewer: AuthUser, coach: { id: string; role: 'MENTOR' | 'HEAD_COACH' }): Promise<boolean> {
    const coachId = coach.id;
    // An unsupported role sees nothing — not even its own account (least privilege, as for students).
    if (!(APP_ROLES as readonly string[]).includes(viewer.role)) return false;
    if (viewer.id === coachId || isAdmin(viewer)) return true;
    if (coach.role === 'MENTOR' && isHeadCoach(viewer)) {
      const headed = await this.access.programmeScope(viewer);
      if (headed !== 'all' && headed.length > 0 && (await this.prisma.programmeMembership.count({
        where: { userId: coachId, isActive: true, disciplineId: { in: headed } },
      })) > 0) return true;
    }
    // A course discussion the person takes part in, readable by the viewer (the discussions' own check).
    const scopes = await this.access.courseScopes({ id: coachId, role: coach.role });
    for (const scope of scopes) {
      if (viewer.role === 'STUDENT' && viewer.divisionId !== scope.divisionId) continue;   // never readable: skip the query
      try {
        await this.access.assertCanView(viewer, scope);
        return true;
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;   // a real fault is not a "no"
        // refused (403 / 404): not readable by this viewer — try the coach's next course
      }
    }
    return false;
  }
}

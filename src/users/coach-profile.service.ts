/**
 * Who may view a COACH's profile — and so their picture (owner 2026-11-27: "a user's profile picture must be visible
 * to everyone who has permission to view that user's profile"). There is no separate coach profile page; a coach's name
 * and picture reach other people only through these existing permissions, which this rule reuses:
 *  - the coach themself;
 *  - Administrators and Super Administrators (they manage every account);
 *  - the Head Coaches of a programme the coach belongs to (AccessService.programmeScope — the scope Head Coaches already
 *    use to manage their programme's coaches);
 *  - anyone who may read a course discussion the coach takes part in: for each (course, division) the coach works in
 *    (AccessService.courseScopes), AccessService.assertCanView — the very check of the discussions — decides. In
 *    practice: the students of that division in that course, and the coaches and Head Coaches working there;
 *  - anyone else (Teachers, students of other divisions, unrelated coaches, an unsupported role): no — the same 404 as
 *    "no picture" (AvatarService.send), so the answer never reveals whether the coach has one.
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

  /** Whether `viewer` may view this coach's profile and picture (see the file header). */
  async mayView(viewer: AuthUser, coachId: string): Promise<boolean> {
    // An unsupported role sees nothing — not even its own account (least privilege, as for students).
    if (!(APP_ROLES as readonly string[]).includes(viewer.role)) return false;
    if (viewer.id === coachId || isAdmin(viewer)) return true;
    if (isHeadCoach(viewer)) {
      const headed = await this.access.programmeScope(viewer);
      if (headed !== 'all' && headed.length > 0 && (await this.prisma.programmeMembership.count({
        where: { userId: coachId, isActive: true, disciplineId: { in: headed } },
      })) > 0) return true;
    }
    // A course discussion the coach takes part in, readable by the viewer (the discussions' own check).
    const scopes = await this.access.courseScopes({ id: coachId, role: 'MENTOR' });
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

/**
 * The notifications administrators, Super Administrators, coaches and Head Coaches
 * can switch on or off (Super Administrators receive what administrators receive;
 * Head Coaches what coaches receive for course work an Administrator assigned them),
 * in their profile settings, with a label and description for the settings screen.
 *
 *   roles — who receives this type (and therefore sees the switch);
 *   email — whether this type is ever e-mailed (in-app-only types have no
 *           e-mail switch).
 *
 * Every type is on by default. Students' notifications (new assignments,
 * deadlines, results …) are not switchable; students keep the per-category
 * e-mail preferences.
 */
import type { NotificationCategory, Role } from '../generated/prisma/client.js';
import { Events } from './events.js';

export interface NotificationTypeInfo {
  type:        string;
  category:    NotificationCategory;
  label:       string;
  description: string;
  roles:       Role[];
  email:       boolean;
}

export const CONFIGURABLE_NOTIFICATION_TYPES: readonly NotificationTypeInfo[] = [
  // ── Administrators ─────────────────────────────────────────────────────────
  {
    type: Events.AssignmentSubmittedForReview, category: 'ASSIGNMENTS', roles: ['ADMIN', 'SUPER_ADMIN'], email: true,
    label: 'Assignments awaiting publication',
    description: 'A coach submitted an assignment for you to publish or return.',
  },
  {
    type: Events.ReviewReturned, category: 'REVIEWS', roles: ['ADMIN', 'SUPER_ADMIN'], email: false,
    label: 'Reviews awaiting approval',
    description: 'A coach finished reviewing a submission and it is ready for your approval.',
  },
  {
    type: Events.StudentRegistered, category: 'ACCOUNT', roles: ['ADMIN', 'SUPER_ADMIN'], email: false,
    label: 'New student registrations',
    description: 'A student created an account (and, when approval is required, is waiting for it).',
  },
  {
    type: Events.MentorRequestSubmitted, category: 'ACCOUNT', roles: ['ADMIN', 'SUPER_ADMIN'], email: false,
    label: 'New coach applications',
    description: 'Someone applied to become a coach and is waiting for a decision.',
  },
  {
    type: Events.TeacherApplicationSubmitted, category: 'ACCOUNT', roles: ['ADMIN', 'SUPER_ADMIN'], email: false,
    label: 'New teacher applications',
    description: 'Someone applied to register as a teacher and is waiting for a decision.',
  },
  {
    type: Events.ContentReported, category: 'DISCUSSIONS', roles: ['ADMIN', 'SUPER_ADMIN'], email: false,
    label: 'Reported discussion content',
    description: 'Someone reported a discussion thread or comment for moderation.',
  },

  // ── Mentors ────────────────────────────────────────────────────────────────
  {
    type: Events.SubmissionsAssigned, category: 'REVIEWS', roles: ['MENTOR', 'HEAD_COACH'], email: true,
    label: 'Submissions assigned to you',
    description: 'Student work was assigned to you for review.',
  },
  {
    type: Events.ReviewRejected, category: 'REVIEWS', roles: ['MENTOR', 'HEAD_COACH'], email: true,
    label: 'Reviews returned to you',
    description: 'An administrator sent one of your reviews back, or reopened a published result.',
  },
  {
    type: Events.AssignmentPublished, category: 'ASSIGNMENTS', roles: ['MENTOR', 'HEAD_COACH'], email: true,
    label: 'Your assignment was published',
    description: 'An administrator published an assignment you prepared.',
  },
  {
    type: Events.AssignmentRejected, category: 'ASSIGNMENTS', roles: ['MENTOR', 'HEAD_COACH'], email: true,
    label: 'Your assignment was returned',
    description: 'An administrator returned an assignment you prepared, with comments.',
  },
  {
    type: Events.DiscussionThreadCreated, category: 'DISCUSSIONS', roles: ['MENTOR', 'HEAD_COACH'], email: false,
    label: 'New discussions in your courses',
    description: 'A new discussion was started in a course or assignment you teach.',
  },

  // ── Both ───────────────────────────────────────────────────────────────────
  {
    type: Events.DiscussionCommentPosted, category: 'DISCUSSIONS', roles: ['ADMIN', 'SUPER_ADMIN', 'MENTOR', 'HEAD_COACH'], email: false,
    label: 'Replies to your posts',
    description: 'Someone posted in a discussion you started or replied to your comment.',
  },
  {
    type: Events.ContentModerated, category: 'DISCUSSIONS', roles: ['ADMIN', 'SUPER_ADMIN', 'MENTOR', 'HEAD_COACH'], email: true,
    label: 'Moderation of your posts',
    description: 'One of your discussion posts was hidden, removed, restored or locked.',
  },
  {
    type: Events.ReportsResolved, category: 'DISCUSSIONS', roles: ['ADMIN', 'SUPER_ADMIN', 'MENTOR', 'HEAD_COACH'], email: false,
    label: 'Outcome of your reports',
    description: 'Content you reported has been reviewed.',
  },
];

const BY_TYPE = new Map(CONFIGURABLE_NOTIFICATION_TYPES.map((t) => [t.type, t]));

export const isConfigurableType = (type: string) => BY_TYPE.has(type);

/** The switchable types a role receives. */
export const configurableTypesFor = (role: Role) =>
  CONFIGURABLE_NOTIFICATION_TYPES.filter((t) => t.roles.includes(role));

export const notificationTypeInfo = (type: string) => BY_TYPE.get(type);

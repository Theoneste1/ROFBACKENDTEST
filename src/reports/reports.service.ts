import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/errors/app-error.js';
import { OPEN_REVIEW } from '../submissions/submissions.constants.js';
import { toCsv } from './csv.js';

const MAX_ROWS = 50_000;

/** Admin reporting: a dashboard overview and CSV exports. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Headline numbers for the admin dashboard. */
  async overview() {
    const [usersByRole, studentsByDivision, pendingStudents, pendingMentors, assignmentsByStatus, submissionsByStatus, failedEmails, divisions] =
      await Promise.all([
        this.prisma.user.groupBy({ by: ['role'], where: { isActive: true }, _count: { _all: true } }),
        this.prisma.user.groupBy({ by: ['divisionId'], where: { role: 'STUDENT', isActive: true }, _count: { _all: true } }),
        this.prisma.user.count({ where: { role: 'STUDENT', isApproved: false, isActive: true } }),
        this.prisma.mentorRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.assignment.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.submission.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
        this.prisma.division.findMany({ select: { id: true, code: true, name: true } }),
      ]);

    const toMap = <T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string | null) =>
      Object.fromEntries(rows.map((r) => [key(r) ?? 'NONE', r._count._all]));

    return {
      generatedAt: new Date(),
      activeUsers: toMap(usersByRole, (r) => r.role),
      studentsByDivision: divisions.map((d) => ({
        ...d,
        students: studentsByDivision.find((s) => s.divisionId === d.id)?._count._all ?? 0,
      })),
      actionRequired: {
        studentsAwaitingApproval:    pendingStudents,
        mentorApplications:          pendingMentors,
        assignmentsAwaitingApproval: assignmentsByStatus.find((a) => a.status === 'PENDING_APPROVAL')?._count._all ?? 0,
        submissionsToDistribute:     submissionsByStatus.find((s) => s.status === 'SUBMITTED')?._count._all ?? 0,
        reviewsAwaitingApproval:     submissionsByStatus.find((s) => s.status === 'SUBMITTED_TO_ADMIN')?._count._all ?? 0,
        resultsReadyToPublish:       submissionsByStatus.find((s) => s.status === 'APPROVED')?._count._all ?? 0,
        failedEmails,
      },
      assignments: toMap(assignmentsByStatus, (r) => r.status),
      submissions: toMap(submissionsByStatus, (r) => r.status),
    };
  }

  /** One row per submission with its result. Filter by assignment or by course × division. */
  async resultsCsv(q: { assignmentId?: string; courseId?: string; divisionId?: string }) {
    if (!q.assignmentId && !(q.courseId && q.divisionId)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILTER_REQUIRED', 'Provide assignmentId, or courseId and divisionId.');
    }
    const rows = await this.prisma.submission.findMany({
      where: q.assignmentId
        ? { assignmentId: q.assignmentId }
        : { assignment: { courseId: q.courseId, divisionId: q.divisionId } },
      orderBy: [{ assignment: { deadline: 'asc' } }, { student: { lastName: 'asc' } }],
      take:    MAX_ROWS,
      select: {
        status: true, score: true, percentage: true, pointsAwarded: true, isLate: true,
        revisionCount: true, submittedAt: true, publishedAt: true,
        assignment: { select: { title: true, maximumMarks: true, course: { select: { title: true } }, division: { select: { name: true } } } },
        student:    { select: { firstName: true, lastName: true, username: true, gradeLevel: true, school: { select: { name: true } } } },
        mentor:     { select: { firstName: true, lastName: true } },
      },
    });

    return toCsv(
      ['Course', 'Division', 'Assignment', 'Student', 'Username', 'Grade', 'School', 'Status',
       'Score', 'Max marks', 'Percentage', 'Points', 'Late', 'Resubmissions', 'Mentor', 'Submitted at', 'Published at'],
      rows.map((r) => [
        r.assignment.course.title, r.assignment.division.name, r.assignment.title,
        `${r.student.firstName} ${r.student.lastName}`, r.student.username, r.student.gradeLevel,
        r.student.school?.name, r.status,
        r.status === 'PUBLISHED' ? r.score : null, r.assignment.maximumMarks,
        r.status === 'PUBLISHED' ? r.percentage : null, r.pointsAwarded,
        r.isLate ? 'yes' : 'no', r.revisionCount,
        r.mentor ? `${r.mentor.firstName} ${r.mentor.lastName}` : null,
        r.submittedAt, r.publishedAt,
      ]),
    );
  }

  /** One row per student in a division with course progress and results summary. */
  async studentProgressCsv(divisionId: string) {
    const division = await this.prisma.division.findUnique({ where: { id: divisionId } });
    if (!division) throw new NotFoundException('Division not found.');

    const [students, courses] = await Promise.all([
      this.prisma.user.findMany({
        where:   { role: 'STUDENT', divisionId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take:    MAX_ROWS,
        select: {
          id: true, firstName: true, lastName: true, username: true, email: true, gradeLevel: true,
          isActive: true, points: true, problemsSolved: true, lastLoginAt: true,
          school: { select: { name: true } },
          courseEnrollments: { select: { courseId: true, status: true } },
          submissions: { select: { status: true, percentage: true } },
        },
      }),
      this.prisma.course.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, title: true } }),
    ]);

    return toCsv(
      ['Student', 'Username', 'Email', 'Grade', 'School', 'Active', 'Points', 'Results published',
       'Average %', 'Submissions', ...courses.map((c) => `${c.title} status`), 'Last login'],
      students.map((s) => {
        const published = s.submissions.filter((x) => x.status === 'PUBLISHED');
        const avg = published.length
          ? Math.round((published.reduce((a, x) => a + (x.percentage ?? 0), 0) / published.length) * 10) / 10
          : null;
        return [
          `${s.firstName} ${s.lastName}`, s.username, s.email, s.gradeLevel, s.school?.name,
          s.isActive ? 'yes' : 'no', s.points, published.length, avg, s.submissions.length,
          ...courses.map((c) => s.courseEnrollments.find((e) => e.courseId === c.id)?.status ?? 'UNROLLED'),
          s.lastLoginAt,
        ];
      }),
    );
  }

  /** One row per mentor: scopes, open reviews, completed reviews and turnaround. */
  async mentorWorkloadCsv() {
    const mentors = await this.prisma.user.findMany({
      where:   { role: 'MENTOR' },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        firstName: true, lastName: true, username: true, email: true, isActive: true,
        mentorAssignments: {
          where:  { isActive: true },
          select: { course: { select: { title: true } }, division: { select: { name: true } } },
        },
        assignedSubmissions: { select: { status: true, assignedAt: true, submittedToAdminAt: true } },
      },
    });

    return toCsv(
      ['Mentor', 'Username', 'Email', 'Active', 'Teaching', 'Open reviews', 'Returned reviews', 'Average review hours'],
      mentors.map((m) => {
        const open     = m.assignedSubmissions.filter((s) => OPEN_REVIEW.includes(s.status)).length;
        const returned = m.assignedSubmissions.filter((s) => s.submittedToAdminAt);
        const hours = returned
          .filter((s) => s.assignedAt)
          .map((s) => (s.submittedToAdminAt!.getTime() - s.assignedAt!.getTime()) / 3_600_000);
        return [
          `${m.firstName} ${m.lastName}`, m.username, m.email, m.isActive ? 'yes' : 'no',
          m.mentorAssignments.map((a) => `${a.course.title} (${a.division.name})`).join('; '),
          open, returned.length,
          hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
        ];
      }),
    );
  }

  /** Active students per school and grade. */
  async enrollmentCsv() {
    const rows = await this.prisma.user.groupBy({
      by:     ['schoolId', 'gradeLevel'],
      where:  { role: 'STUDENT', isActive: true },
      _count: { _all: true },
    });
    const schools = new Map(
      (await this.prisma.school.findMany({ select: { id: true, name: true, location: true } })).map((s) => [s.id, s]),
    );

    return toCsv(
      ['School', 'Location', 'Grade', 'Students'],
      rows
        .map((r) => {
          const school = r.schoolId ? schools.get(r.schoolId) : undefined;
          return [school?.name ?? '(no school)', school?.location, r.gradeLevel, r._count._all];
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))),
    );
  }
}

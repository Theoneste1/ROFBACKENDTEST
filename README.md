# ROF API

A NestJS-based learning and assessment platform for managing users, schools, courses, assignments, submissions, study groups, discussions, mentorship requests, email jobs, and audit logs.

## Overview

This backend provides the core application services for:

- Authentication and authorization
- Student, mentor, and admin account management
- School and leaderboard data
- Course and resource publishing
- Assignment creation and submission workflows
- Review, marking, and moderation
- Discussion threads and comments
- Study group membership and roles
- Audit logging and admin email operations

## Tech Stack

- NestJS
- TypeScript
- PostgreSQL
- Prisma ORM
- JWT authentication
- Passport
- Class-validator / DTO validation
- Multer for file uploads

## Prerequisites

- Node.js 20+
- PostgreSQL database
- npm

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root with values similar to:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/rof"
JWT_SECRET="your_super_secret_key"
PORT=3000
```

The app also expects the Prisma Postgres connection and JWT secret to be available during startup.

## Running the App

```bash
# development
npm run start

# watch mode
npm run start:dev

# production
npm run start:prod
```

## Database Setup

```bash
npx prisma generate
npx prisma migrate deploy
```

Seed the first admin account:

```bash
npx tsx prisma/seed.ts
```

Default seeded admin:

- Username: admin
- Password: Admin123!

> Change this password after first login.

## Testing

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## API Base URL

```text
http://localhost:3000
```

## Routes and Request Bodies

The following list covers the application routes and the JSON payloads used for request bodies.

---

## 1) Authentication

### POST /auth/register/student

Creates a student account.

Request body:

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "username": "jdoe",
  "email": "john@example.com",
  "password": "Pass1234",
  "schoolName": "Example School",
  "schoolLocation": "Nairobi",
  "homeLocation": "Nairobi"
}
```

### POST /auth/register/admin

Creates an admin account. Requires authentication and admin role.

Request body:

```json
{
  "firstName": "System",
  "lastName": "Admin",
  "username": "sysadmin",
  "email": "admin@example.com",
  "password": "Pass1234"
}
```

### POST /auth/login

Logs in a user.

Request body:

```json
{
  "username": "jdoe",
  "password": "Pass1234"
}
```

### POST /auth/logout

Logs a user out and blacklists the token. Requires authentication.

No request body.

### GET /auth/me

Returns the current authenticated user details.

No request body.

---

## 2) Users

### GET /users

Fetch all users.

No request body.

### POST /users

Creates a user.

Request body:

```json
{
  "firstName": "Alice",
  "lastName": "Smith",
  "username": "alice",
  "email": "alice@example.com",
  "password": "Pass1234",
  "role": "STUDENT"
}
```

### GET /users/:id

Fetch a specific user by ID.

No request body.

### PATCH /users/:id

Updates a user.

Request body example:

```json
{
  "firstName": "Alice",
  "lastName": "Smith",
  "email": "alice.new@example.com"
}
```

### DELETE /users/:id

Deletes a user.

No request body.

### POST /users/:id/progress

Registers or updates user progress.

No request body in the route signature.

---

## 3) Schools

### GET /schools

Fetch all schools.

No request body.

### GET /schools/:id

Fetch a specific school by ID.

No request body.

---

## 4) Leaderboard

### GET /leaderboard

Returns leaderboard data.

No request body.

### GET /leaderboard/schools

Fetch school leaderboard data.

No request body.

### GET /leaderboard/schools/:schoolId

Fetch leaderboard data for a school.

No request body.

---

## 5) Courses

### POST /courses

Creates a course.

Request body:

```json
{
  "title": "Mathematics 101",
  "description": "Basic algebra and functions course for beginners.",
  "subject": "Algebra"
}
```

### GET /courses/mine

My courses.

No request body.

### GET /courses/admin/all

All courses for admins.

No request body.

### GET /courses

Fetch all courses.

No request body.

### GET /courses/:id

Fetch course by ID.

No request body.

### POST /courses/:id/complete

Marks a course as complete.

No request body.

### GET /courses/my/enrollments

Get my course enrollments.

No request body.

### PATCH /courses/:id

Updates a course.

Request body example:

```json
{
  "title": "Advanced Mathematics",
  "description": "Updated course description for the next intake.",
  "subject": "Algebra"
}
```

### PATCH /courses/:id/submit

Submits a course for approval.

No request body.

### PATCH /courses/:id/recall

Recalls a submitted course.

No request body.

### PATCH /courses/:id/publish

Publishes a course.

No request body.

### PATCH /courses/:id/reject

Rejects a course.

No request body.

### PATCH /courses/:id/unpublish

Unpublishes a course.

No request body.

### POST /courses/:courseId/resources

Uploads a course resource.

Request body example:

```json
{
  "title": "Week 1 Notes",
  "type": "NOTE",
  "description": "Lecture notes for the first week of the course."
}
```

### GET /courses/:courseId/resources

List resources for a course.

No request body.

### GET /courses/:courseId/resources/:resourceId

Get one resource.

No request body.

### GET /courses/:courseId/resources/:resourceId/file

Download a resource file.

No request body.

### PATCH /courses/:courseId/resources/:resourceId

Update a resource.

Request body example:

```json
{
  "title": "Updated Notes",
  "description": "Updated lecture notes.",
  "type": "NOTE"
}
```

### PATCH /courses/:courseId/resources/:resourceId/publish

Publish a resource.

No request body.

### PATCH /courses/:courseId/resources/:resourceId/unpublish

Unpublish a resource.

No request body.

### DELETE /courses/:courseId/resources/:resourceId

Delete a resource.

No request body.

---

## 6) Assignments

### POST /assignments

Creates an assignment.

Request body:

```json
{
  "title": "Algebra Quiz",
  "courseId": "550e8400-e29b-41d4-a716-446655440000",
  "instructions": "Solve all questions and submit before the deadline.",
  "deadline": "2026-10-25T23:59:59.000Z",
  "points": 20,
  "maximumMarks": 100,
  "allowResubmission": true,
  "maxResubmissions": 2
}
```

### GET /assignments/mine

Get assignments assigned to the current user.

No request body.

### GET /assignments/admin/all

Get all assignments for admin oversight.

No request body.

### GET /assignments/my-assignments

Get my assignment list.

No request body.

### GET /assignments

Fetch all assignments.

No request body.

### GET /assignments/:id

Fetch a specific assignment.

No request body.

### PATCH /assignments/:id

Update an assignment.

Request body example:

```json
{
  "title": "Updated Algebra Quiz",
  "instructions": "Solve all five questions.",
  "deadline": "2026-10-27T18:00:00.000Z",
  "points": 25,
  "maximumMarks": 120
}
```

### PATCH /assignments/:id/submit

Submit an assignment.

No request body.

### PATCH /assignments/:id/recall

Recall a submitted assignment.

No request body.

### PATCH /assignments/:id/publish

Publish the assignment.

No request body.

### PATCH /assignments/:id/reject

Reject the assignment.

No request body.

### PATCH /assignments/:id/unpublish

Unpublish the assignment.

No request body.

### GET /assignments/:id/download

Download an assignment file.

No request body.

---

## 7) Submissions

### POST /submissions

Create a submission for an assignment.

Request body:

```json
{
  "assignmentId": "550e8400-e29b-41d4-a716-446655440000",
  "note": "Submitted with final answer sheet."
}
```

### GET /submissions/my-submissions

Get my submissions.

No request body.

### GET /submissions

Fetch all submissions.

No request body.

### GET /submissions/:id

Fetch one submission.

No request body.

### PATCH /submissions/:id/assign

Assign a submission to a mentor.

Request body example:

```json
{
  "mentorId": "e58c6d17-4a8a-4ea1-a67b-98a14c5ef1fa"
}
```

### PATCH /submissions/:id/reassign

Reassign a submission.

Request body example:

```json
{
  "mentorId": "e58c6d17-4a8a-4ea1-a67b-98a14c5ef1fa"
}
```

### GET /submissions/my-assignments

Get assigned review tasks.

No request body.

### PATCH /submissions/:id/start-review

Begin review on a submission.

No request body.

### PATCH /submissions/:id/mark

Mark a submission.

Request body example:

```json
{
  "marks": 82,
  "feedback": "Good work. Please improve the final explanation."
}
```

### PATCH /submissions/:id/submit-to-admin

Submit the reviewed result to admin.

No request body.

### PATCH /submissions/:id/approve

Approve a submission.

No request body.

### PATCH /submissions/:id/reject

Reject a submission.

No request body.

### PATCH /submissions/:id/publish

Publish a submission result.

No request body.

### PATCH /submissions/:id/correct

Correct a submission.

Request body example:

```json
{
  "marks": 90,
  "feedback": "Excellent corrections and clear reasoning."
}
```

### GET /submissions/:id/download-submission

Download the original student submission file.

No request body.

### GET /submissions/:id/download-feedback

Download marking feedback.

No request body.

---

## 8) Mentor Requests

### POST /mentor-requests

Create a mentor request.

Request body:

```json
{
  "schoolId": "...",
  "reason": "I want to mentor students in mathematics."
}
```

### GET /mentor-requests

List mentor requests.

No request body.

### PATCH /mentor-requests/:id/approve

Approve a mentor request.

No request body.

### PATCH /mentor-requests/:id/reject

Reject a mentor request.

No request body.

---

## 9) Study Groups

### POST /study-groups

Create a study group.

Request body:

```json
{
  "name": "Algebra Group",
  "description": "Weekly maths revision sessions.",
  "tags": "algebra,revision",
  "isActive": true
}
```

### PATCH /study-groups/:id

Update a study group.

Request body example:

```json
{
  "name": "Algebra Revision Group",
  "description": "Updated study schedule for the semester.",
  "isActive": true
}
```

### GET /study-groups

List study groups.

No request body.

### POST /study-groups/:id/members

Add member to a group.

Request body:

```json
{
  "userId": "e58c6d17-4a8a-4ea1-a67b-98a14c5ef1fa",
  "groupRole": "STUDENT"
}
```

### PATCH /study-groups/:id/members/:userId/role

Update a member role in a group.

Request body:

```json
{
  "groupRole": "MENTOR"
}
```

### DELETE /study-groups/:id/members/:userId

Remove a member from a group.

No request body.

### GET /study-groups/:id/members/history

View membership history for a group.

No request body.

### GET /study-groups/:id

Get a study group by ID.

No request body.

### GET /study-groups/my/groups

Get the current user’s groups.

No request body.

---

## 10) Discussions

### GET /courses/:courseId/comments

List comments for a course.

No request body.

### POST /courses/:courseId/comments

Create a course comment.

Request body:

```json
{
  "content": "This section is very helpful. Thank you!",
  "parentId": null
}
```

### GET /assignments/:assignmentId/comments

List comments for an assignment.

No request body.

### POST /assignments/:assignmentId/comments

Create an assignment comment.

Request body:

```json
{
  "content": "I would like to clarify the deadline.",
  "parentId": null
}
```

### GET /comments/:id/replies

Fetch replies for a comment.

No request body.

### PATCH /comments/:id

Update a comment.

Request body:

```json
{
  "content": "Updated comment text."
}
```

### DELETE /comments/:id

Delete a comment.

No request body.

### PATCH /comments/:id/hide

Hide a comment.

No request body.

### PATCH /comments/:id/restore

Restore a hidden comment.

No request body.

### POST /comments/:id/reactions

Add a reaction to a comment.

Request body:

```json
{
  "type": "LIKE"
}
```

---

## 11) Email and Admin Tools

### GET /admin/email/users

List email users.

No request body.

### POST /admin/email/send

Send an email.

Request body example:

```json
{
  "to": ["student@example.com"],
  "subject": "Course Reminder",
  "message": "Your course session starts tomorrow.",
  "template": "generic"
}
```

### GET /admin/email/jobs

List email jobs.

No request body.

### GET /admin/email/jobs/:id

Fetch an email job by ID.

No request body.

### POST /admin/email/jobs/:id/retry

Retry a failed email job.

No request body.

---

## 12) Audit Logs

### GET /audit-logs

List audit logs.

No request body.

---

## Authentication Notes

Most protected routes require a JWT bearer token.

Example:

```http
Authorization: Bearer <token>
```

---

## Notes

- Validation is enforced through DTOs using class-validator.
- Files are uploaded for assignments, submissions, and course resources.
- Prisma is used as the database layer and database migrations are stored under the `prisma` directory.
- A default admin user can be created using the seed script in `prisma/seed.ts`.

## License

This project is private and intended for internal or project-specific use unless otherwise stated.

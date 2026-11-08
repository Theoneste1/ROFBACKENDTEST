# ROF LMS — CONSOLIDATED PRODUCT REQUIREMENTS AND DEVELOPMENT SPECIFICATION

**Project:** Rwanda Olympiad Foundation Learning Management System (ROF LMS)  
**Product vision:** An international Olympiad learning and development platform  
**Document purpose:** Master requirements for backend and frontend development  
**Status:** Requirements baseline for technical audit and implementation planning

---

# 1. PROJECT VISION

The Rwanda Olympiad Foundation Learning Management System (ROF LMS) should become a modern, international platform supporting students, teachers, coaches, administrators and other authorized users interested in Olympiad education.

It should provide an environment where students can discover Olympiad subjects, access learning materials, complete assignments, receive feedback, participate in academic communities and request support services.

The platform must be scalable, secure, accessible, mobile-friendly and adaptable to different countries and educational systems.

The existing application is already functional. This project is an extension and improvement of that application, not a complete rebuild.

## 1.1 Core principles

- Preserve existing working functionality.
- Avoid unnecessary architectural changes.
- Support international users and educational systems.
- Make academic structures configurable through the Admin Portal.
- Enforce permissions on the backend.
- Protect student information, especially information belonging to minors.
- Provide consistent user experiences across all roles.
- Build reusable features that can support future Olympiad programmes.
- Avoid hardcoding information that administrators should be able to manage.

# 2. USER TYPES AND REGISTRATION

The platform should support three primary user types:

1. Students
2. Teachers
3. Coaches

Administrators manage the platform and its users through the Admin Portal.

Registration fields, permissions and approval requirements must depend on the selected user type.

## 2.1 Student registration

Student registration should collect the following information:

**Personal information**
- First Name
- Last Name
- Username
- Date of Birth
- Email Address
- Country
- Student Phone Number (optional)
- Parent, Guardian or Close Family Member Phone Number (mandatory)
- Profile Picture (optional)

**Academic information**
- Country
- School
- Grade or Education Level
- Current academic year, where applicable
- Interested Olympiad Subjects

Students should be able to select one or more subjects they are interested in.

Examples:
- Mathematics
- Physics
- Computing
- Artificial Intelligence
- Other subjects added by administrators.

The available subjects must come from the dynamic academic management system.

The school and grade selection should adapt to the selected country.

For example, a student in Rwanda may use P1–P6 and S1–S6, while another country may use a different grade structure.

The system must not assume that every student follows the Rwandan education system.

**Important:** Registration and academic enrollment are different processes. Registering as a student should not automatically enroll the student in every course or academic division.

## 2.2 Teacher registration

Teacher registration should collect:

- First Name
- Last Name
- Username
- Email Address
- Phone Number (mandatory)
- Country
- School or Institution
- Position or Teaching Role
- Subjects taught
- Years of experience (where appropriate)
- Profile Picture (optional)

Teachers should be able to indicate the Olympiad subjects they teach or are interested in supporting.

Teacher accounts may require verification or administrator approval depending on the registration configuration.

## 2.3 Coach registration

Coach registration should collect:

- First Name
- Last Name
- Username
- Email Address
- Phone Number
- Country
- Institution or Affiliation (where applicable)
- Academic Qualifications or Background
- Olympiad Subjects
- Areas of Expertise
- Relevant Experience
- Profile Picture (optional)

Coaches should be subject to an appropriate verification and approval process.

An approved coach should only receive permissions and academic assignments granted by an authorized administrator.

## 2.4 Registration management

Administrators should be able to:

- Enable or disable public registration.
- Enable or disable registration for individual user types.
- Configure mandatory and optional registration fields where practical.
- Review and approve registrations.
- Reject applications with a reason.
- Request additional information.
- Resend activation emails.
- Suspend and reactivate accounts.
- Import users in bulk.
- Export user records.
- View registration history.

The system should prevent duplicate accounts using appropriate unique identifiers.

# 3. INTERNATIONAL ACADEMIC STRUCTURE

The platform must support multiple countries, educational systems, schools, grade structures and academic calendars.

## 3.1 Country management

Administrators should be able to manage countries and their associated educational structures.

The system should support:
- Country
- Region, Province or District
- City or Locality
- School or Institution
- School Type
- Education System
- Grade or Education Level

These structures should be configurable rather than permanently tied to Rwanda.

## 3.2 School management

Schools should have their own records and identifiable relationships with countries and geographical locations.

Administrators should be able to:
- Add schools.
- Edit school information.
- Activate or deactivate schools.
- Assign school administrators or contacts where supported.
- View students and teachers associated with each school.
- Import schools in bulk.

The system should avoid duplicate school records.

# 4. DYNAMIC ACADEMIC SUBJECTS AND TOPICS

This is a major requirement.

Currently, the platform focuses on Mathematics, including:

- Number Theory
- Algebra
- Geometry
- Combinatorics

We want to expand the platform to support multiple Olympiad subjects.

Initial subjects:
1. Mathematics
2. Physics
3. Computing

Future subjects may include:
- Artificial Intelligence
- Other Olympiad disciplines introduced by the Foundation.

## 4.1 Dynamic subject management

Administrators must be able to create, edit, publish, deactivate and archive academic subjects through the Admin Portal.

Each subject should support:
- Name
- Unique code
- Description
- Image or icon
- Display order
- Status
- Visibility
- Creation and update information

Adding a new subject must not require developers to modify source code or deploy a new application version.

## 4.2 Dynamic topics

Each subject should have its own topics.

For example:

**Mathematics**
- Number Theory
- Algebra
- Geometry
- Combinatorics

Administrators should be able to add, rename, reorder, deactivate and archive topics.

Physics and Computing should have their own independent topic structures.

Topics must not be restricted to a fixed list in the source code.

## 4.3 Academic hierarchy

The academic structure should support an appropriate hierarchy such as:

Subject → Topic → Course or Learning Programme → Learning Resources and Assessments.

The existing Division and Course structures should be reviewed and extended where necessary.

The design should allow subjects to have different learning structures without forcing every subject to use identical assumptions.

## 4.4 Subject-specific academic access

Students should be able to access subjects and courses for which they have the appropriate access.

Coaches should be assigned to the relevant subjects, courses and academic groups by authorized administrators.

Administrators should be able to control which subjects are available to different student levels, countries or academic programmes.

Existing Mathematics data and relationships must be preserved during migration.

# 5. COURSE, DIVISION AND ENROLLMENT MANAGEMENT

The platform should support flexible management of:

- Academic years
- Subjects
- Topics
- Courses
- Divisions or learning levels
- Student enrollments
- Coach assignments

The existing Junior and Senior divisions should continue working while the system is evaluated for more flexible international academic structures.

Administrators should be able to manage course availability, assign coaches and control enrollment.

Course enrollment must be separate from user registration.

Students should not automatically gain access to restricted learning materials merely because they have created an account.

# 6. USER MANAGEMENT AND ACCOUNT LIFECYCLE

The Admin Portal should provide comprehensive user management.

Administrators should be able to:

- Search and filter users.
- View complete user profiles.
- Edit permitted user information.
- Approve or reject applications.
- Invite users.
- Suspend and reactivate accounts.
- Change user permissions where authorized.
- Reset accounts and resend activation links.
- Perform bulk operations.
- Import and export users.
- View user activity and account history.

## 6.1 Account status

Support clear account states, such as:

- Pending Verification
- Pending Approval
- Active
- Suspended
- Rejected
- Archived

The exact states and permitted transitions should be defined consistently.

## 6.2 Soft deletion and restoration

Where appropriate, deleting a user should be a reversible soft-deletion operation.

Administrators with the correct permissions should be able to restore archived or deleted records.

Permanent deletion should be restricted and governed by data retention and privacy requirements.

## 6.3 User profiles

Users should have appropriate profile management features.

Where applicable, users should be able to update:
- Profile picture
- Contact details
- Country and location
- School or institution
- Academic information
- Areas of interest

Sensitive information should have appropriate access restrictions.

# 7. ROLE-BASED ACCESS CONTROL AND PERMISSIONS

The existing fixed three-role permission model should be reviewed and extended to support more granular administration.

The system should distinguish five concepts:

1. User Type: Student, Teacher, Coach or Administrator.
2. Organizational Role: The user's responsibility within the Foundation or a programme.
3. Permission Profile: A reusable collection of permissions.
4. Individual Permissions: Additional or restricted permissions assigned to a user.
5. Scope: The resources, subjects, courses, schools, groups or records to which permissions apply.

## 7.1 Permission profiles

Administrators should be able to create reusable permission profiles.

Examples:
- Super Administrator
- User Management Administrator
- Academic Administrator
- Content Administrator
- Communication Administrator
- Student Support Administrator
- Subject Coordinator
- Coach
- Teacher
- Student

These are examples, not a requirement to create every profile automatically.

## 7.2 Granular permissions

Permissions should be configurable by functional area.

Examples:
- View Users
- Create Users
- Edit Users
- Suspend Users
- Approve Registrations
- Manage Subjects
- Manage Topics
- Manage Courses
- Publish Resources
- Approve Assignments
- Manage Communication Groups
- Send Targeted Emails
- Manage Support Requests
- View Reports
- Export Data
- Manage System Settings

## 7.3 Scope restrictions

Permissions should support appropriate restrictions by:
- Country
- School
- Subject
- Course
- Division
- Communication Group
- Assigned Support Requests
- Other relevant resources

## 7.4 Security requirements

- Apply default-deny authorization.
- Enforce access checks on the backend.
- Do not rely on frontend visibility to protect data.
- Prevent privilege escalation.
- Record sensitive permission changes in audit logs.
- Ensure administrators cannot grant permissions beyond their own authority.
- Protect student records from unauthorized access.

The new design must remain compatible with the existing authentication system unless a necessary change is justified.

# 8. LEARNING CONTENT AND PUBLISHING WORKFLOWS

The platform should provide a consistent content management and approval system.

Learning content may include:
- Notes
- Books
- E-books
- Past Papers
- Assignments
- Other learning resources

## 8.1 Publishing workflow

Where approval is required, support a workflow such as:

Draft → Pending Approval → Published

Additional states:
- Changes Requested
- Rejected
- Archived
- Unpublished

The permitted transitions should depend on user permissions.

## 8.2 Content versioning

When published content is edited:

- The published version should remain available.
- Changes should create a new revision.
- The new revision should undergo approval where required.
- The existing published version should remain visible until the replacement is approved.
- Administrators should be able to review version history.
- The system should record who created, edited, reviewed and approved each version.

Avoid overwriting published content without preserving its history.

# 9. STUDENT SUPPORT AND SERVICES PORTAL

We want a dedicated Student Support and Services area.

This should replace or expand the existing Requests functionality into a proper service management module.

Students should be able to submit requests such as:

- Recommendation Letters
- Certificates
- Coach Meeting Requests
- Academic Support
- Technical Support
- General Student Support
- Other categories configured by administrators

## 9.1 Request submission

A student should be able to:

- Select a request category.
- Enter a subject and description.
- Attach supporting documents where appropriate.
- Submit the request.
- Receive a unique reference number.
- Track its status.
- View responses and updates.
- Receive notifications when the status changes.

## 9.2 Request management

Authorized staff should be able to:

- View and filter requests.
- Assign requests to staff members.
- Change priority.
- Update statuses.
- Request additional information.
- Add internal notes.
- Respond to students.
- Attach documents.
- Close and reopen requests where permitted.

Suggested statuses:

- Submitted
- Under Review
- Assigned
- Awaiting Student Information
- In Progress
- Approved
- Rejected
- Completed
- Closed

The final workflow should be configurable where practical.

Internal staff notes must be separated from messages visible to students.

## 9.3 Meeting requests

For coach meeting requests, support:
- Requested meeting purpose.
- Preferred dates or times.
- Assigned coach.
- Meeting confirmation.
- Meeting status.
- Meeting outcome or follow-up notes.

Do not assume that submitting a request automatically confirms a meeting.

# 10. COMMUNICATION GROUPS AND COMMUNITY

The platform should support independent communication groups.

Examples:
- IMO2026
- EGMO2027
- National Mathematics Olympiad Team
- Physics Olympiad Preparation
- Computing Olympiad Team
- Other programmes and initiatives.

These groups should be independent of course enrollment and academic divisions.

A student may belong to a communication group without being enrolled in a particular course.

## 10.1 Group management

Authorized administrators should be able to:

- Create groups.
- Edit group information.
- Archive groups.
- Add or remove members.
- Invite users.
- Assign group administrators or moderators.
- Configure membership visibility.
- Configure messaging and discussion permissions.

## 10.2 Communication

Depending on the approved technical design, support:

- Group announcements.
- Discussions.
- Messages.
- Replies.
- Mentions.
- Notifications.
- Attachments.
- Moderation and reporting.

## 10.3 Delegated permissions

Group administrators should only manage the groups and activities assigned to them.

They must not automatically receive global administrator permissions.

## 10.4 Targeted emails

Authorized users should be able to send emails to selected groups or audiences.

Possible audiences:
- Specific communication groups.
- Students.
- Teachers.
- Coaches.
- Countries.
- Schools.
- Subjects.
- Other permitted selections.

The system should provide recipient previews and confirmation before sending bulk communications.

All bulk email activities should be logged.

# 11. NOTIFICATIONS AND COMMUNICATION PREFERENCES

The platform should provide a consistent notification system.

Notifications may relate to:
- Registration and account activation.
- Password resets.
- Assignments.
- Submissions.
- Reviews and results.
- New learning resources.
- Publishing decisions.
- Support requests.
- Communication groups.
- Announcements and mentions.

Support in-app and email notifications.

Where appropriate, allow users to configure notification preferences.

The system should prevent duplicate notifications and handle email delivery failures appropriately.

A successful email delivery must not be treated as proof that the recipient has read it.

# 12. ADMIN PORTAL

The Admin Portal should provide a central management environment.

It should support the following areas:

1. Dashboard and analytics.
2. User management.
3. Registration and approvals.
4. Countries and geographical structures.
5. Schools and institutions.
6. Academic years.
7. Subjects and topics.
8. Courses and divisions.
9. Coach assignments.
10. Learning content management.
11. Publishing approvals.
12. Assignments and assessment management.
13. Student Support and Services.
14. Communication groups.
15. Email communications.
16. Notifications.
17. Permission profiles and access management.
18. Reports and exports.
19. Audit logs.
20. Platform settings.

Administrators should only see and access functions permitted by their permissions.

The interface should not display unsupported or non-functional features.

# 13. LOGIN, REGISTRATION AND VISUAL EXPERIENCE

The login and registration experience should be modern, professional and appropriate for an international Olympiad learning platform.

The design should communicate:
- Curiosity
- Academic excellence
- Critical thinking
- Creativity
- Problem solving
- Intellectual growth
- International participation

Use appropriate educational imagery, such as:
- Teachers guiding students.
- Students solving mathematical problems.
- Students working collaboratively.
- Olympiad competitions.
- Physics and computing activities.

The visual design should be attractive to young learners without looking childish.

Preserve the existing authentication functionality.

Do not redesign the application in a way that breaks login, activation, password reset or session management.

# 14. STUDENT EXPERIENCE

The student portal should provide a clear environment for learning and participation.

Students should be able to:

- View their profile.
- View available subjects.
- Access authorized courses.
- Browse topics and learning materials.
- View assignments.
- Submit work.
- View submission status.
- Receive feedback.
- View published results.
- View relevant leaderboards.
- Participate in permitted discussions and groups.
- Receive notifications.
- Submit and track support requests.

Access should be restricted according to enrollment, permissions and publication status.

# 15. TEACHER AND COACH EXPERIENCE

Teachers and coaches should have role-appropriate dashboards.

Depending on their assigned responsibilities, they should be able to:

- View assigned subjects and courses.
- Access relevant learning materials.
- Upload resources.
- Create assignments.
- Submit content for approval.
- Review student submissions where authorized.
- Provide feedback.
- Participate in discussions.
- Manage permitted communication groups.
- Respond to assigned student support requests where authorized.

A coach should not automatically receive access to every student, course or subject.

All actions must respect assigned scope and permissions.

# 16. SECURITY, PRIVACY AND SAFEGUARDING

Security must be considered throughout the project.

Requirements include:

- Secure password storage.
- Secure authentication and session management.
- Backend permission enforcement.
- Input validation.
- Rate limiting.
- Protection against unauthorized file access.
- Secure upload validation.
- Appropriate access logging.
- Protection against common web application vulnerabilities.
- Safe database migrations.
- Secure environment variable handling.
- Backup and recovery procedures.

## 16.1 Protection of minors

Because students may be minors, implement appropriate safeguards.

Examples:
- Restrict access to sensitive student contact information.
- Protect guardian contact details.
- Restrict private communications to authorized contexts.
- Provide moderation and reporting mechanisms.
- Record access to sensitive administrative information where appropriate.
- Collect only information necessary for legitimate platform purposes.

## 16.2 Data privacy

Support appropriate data retention, correction, export and deletion processes.

Sensitive personal information must not appear in URLs, public API responses, email logs or unnecessary audit records.

# 17. TECHNICAL ARCHITECTURE AND DATA MANAGEMENT

The backend and frontend should remain separate applications with clearly defined integration contracts.

The existing architecture should be preserved where practical.

Technical requirements:

- Maintain the existing authentication and refresh-token flow.
- Use documented API contracts.
- Validate inputs on the backend.
- Implement consistent error responses.
- Use pagination and filtering for large datasets.
- Avoid unnecessary database queries.
- Use transactions for multi-step operations.
- Use safe and reversible migrations.
- Preserve existing records and relationships.
- Implement appropriate file storage and access controls.
- Maintain environment separation between development, staging and production.

The system should be designed to accommodate significant growth in users, schools, courses and learning materials.

Avoid introducing unnecessary infrastructure or paid services without justification.

# 18. AUDIT LOGGING AND ACTIVITY HISTORY

The platform should maintain reliable records of important actions.

Examples:
- User creation and modification.
- Permission changes.
- Account suspension and restoration.
- Registration approvals.
- Subject and topic changes.
- Course changes.
- Content publication.
- Assessment approval.
- Support request updates.
- Communication group membership changes.
- Bulk email operations.
- Sensitive data exports.

Audit records should include the actor, action, affected resource and timestamp.

Where appropriate, record the previous and new values without storing passwords, tokens or other secrets.

Audit logs should not be editable by ordinary users.

# 19. PERFORMANCE, RESPONSIVENESS AND ACCESSIBILITY

The platform should:

- Work on desktop, tablet and mobile devices.
- Provide responsive interfaces.
- Support large user and enrollment datasets.
- Use efficient database queries.
- Provide appropriate loading and error states.
- Handle large file uploads safely.
- Support accessible navigation and readable content.
- Avoid unnecessary animations or visual effects that reduce usability.

# 20. TESTING AND QUALITY ASSURANCE

Every new feature must be tested at the appropriate level.

Required testing areas:

- Unit tests.
- API integration tests.
- End-to-end tests.
- Permission and authorization tests.
- Database migration tests.
- Data integrity tests.
- File upload and download tests.
- Email and notification tests.
- Frontend integration tests.
- Regression tests.

Test all major user types and permission profiles.

Important scenarios include:

- A student cannot access another student's restricted records.
- A coach cannot access an unassigned course.
- A group administrator cannot manage unrelated groups.
- A user cannot approve content without permission.
- A pending content revision does not replace an already published version.
- A student can track a support request but cannot access internal staff notes.
- A new subject can be created without a source-code change.
- Existing Mathematics data remains available after migration.

No feature should be marked complete merely because its interface or API exists.

# 21. IMPLEMENTATION PRIORITIES

The project should follow this order.

## Phase 1 — Existing system audit

- Inspect the backend and frontend.
- Review the existing database and API contracts.
- Compare existing functionality against these requirements.
- Identify risks, dependencies and missing functionality.
- Produce a detailed implementation plan.

## Phase 2 — Architectural foundation

- Review the database design.
- Design dynamic academic structures.
- Design international registration structures.
- Design the expanded permission system.
- Define reusable workflows and audit requirements.
- Document API contracts and migration strategy.

## Phase 3 — Backend implementation

- Implement approved database changes.
- Implement dynamic subjects and topics.
- Implement registration improvements.
- Implement granular permissions.
- Implement account management improvements.
- Implement publishing and versioning.
- Implement student support services.
- Implement communication groups.
- Extend notifications and audit logging.

## Phase 4 — Backend verification

- Run migrations safely.
- Test all APIs.
- Test permissions and security.
- Verify data integrity.
- Run regression tests.
- Document the final API contracts.

## Phase 5 — Frontend implementation

- Integrate the new APIs.
- Update the Admin Portal.
- Improve registration and profiles.
- Implement the Student Support Portal.
- Implement communication group interfaces.
- Implement dynamic academic management.
- Improve login and registration visuals.
- Preserve existing working functionality.

## Phase 6 — Full application testing

- Test student workflows.
- Test teacher and coach workflows.
- Test administrator workflows.
- Test permission profiles.
- Test international registration.
- Test communication and support services.
- Test mobile responsiveness.
- Test existing functionality for regressions.

## Phase 7 — Production readiness

- Review environment variables.
- Verify database backups.
- Verify file storage.
- Apply approved production migrations.
- Deploy the backend.
- Deploy the frontend.
- Test production authentication and workflows.
- Monitor errors and application performance.

# 22. DEVELOPMENT RULES

These rules apply to all development work.

1. Audit before implementation.
2. Do not rebuild working features unnecessarily.
3. Do not delete existing production data.
4. Do not make destructive database changes without an approved plan.
5. Do not hardcode configurable subjects, topics, countries, grades or permission profiles.
6. Do not implement frontend-only authorization.
7. Do not give users permissions automatically without authorization.
8. Do not introduce fake data or non-functional placeholder features into production.
9. Do not silently change existing API contracts.
10. Do not mark untested functionality as verified.
11. Keep backend and frontend documentation updated.
12. Maintain a clear Git history and use controlled branches.
13. Test each implementation phase before proceeding.
14. Document important architectural decisions.
15. Preserve the existing authentication and security foundations unless a change is necessary and approved.

# 23. EXPECTED FINAL OUTCOME

The final ROF LMS should be a reliable, international Olympiad learning platform that supports:

- Students from different countries and education systems.
- Teachers and coaches.
- Multiple Olympiad subjects.
- Dynamically managed academic topics and courses.
- Flexible administrative permissions.
- Secure student and account management.
- Learning materials and assessments.
- Content approval and version history.
- Student Support and Services.
- Independent communication groups.
- Targeted communications and notifications.
- Comprehensive reporting and audit trails.

The system must be fully integrated across the backend and frontend, with verified permissions, reliable data management, comprehensive testing and production deployment.

**Final instruction to the development team:** Treat this document as the master product requirements baseline. First compare it against the existing application. Identify what is already implemented, what needs improvement and what is missing. Produce a prioritized implementation plan before changing existing code or database structures.

The objective is to evolve the existing ROF LMS into a complete international platform while preserving its working foundations.
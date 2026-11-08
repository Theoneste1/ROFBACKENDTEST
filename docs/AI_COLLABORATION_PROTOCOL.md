# ROF LMS — AI Collaboration Protocol

**Status:** Proposed; becomes the working protocol when the project owner approves and merges the pull requests.  
**Owner:** ROF LMS project owner  
**Repositories:** `Theoneste1/ROFFRONTENDTEST` and `Theoneste1/ROFBACKENDTEST`

## 1. Purpose

This document defines how GPT and Claude collaborate on the Rwanda Olympiad Foundation Learning Management System (ROF LMS). The goal is consistent decisions, safe implementation, independent review, and human control of releases.

GitHub is the shared source of truth for code, pull requests, project documents, and recorded decisions. This protocol is mirrored in the frontend and backend repositories; keep both copies aligned when it changes.

## 2. Roles

### GPT — Technical architect and independent reviewer

GPT is responsible for:
- Turning the project owner's requests into clear requirements, implementation plans, and acceptance criteria.
- Checking proposed designs against the existing architecture and documented product decisions.
- Reviewing Claude's pull requests for correctness, security, authorization, data integrity, performance, accessibility, and maintainability.
- Checking test evidence and identifying missing tests or risky assumptions.
- Providing actionable findings with file paths, impact, and recommended fixes.
- Avoiding implementation or repository changes unless the project owner explicitly asks.

GPT must not claim to have run tests or inspected files it has not actually accessed. A GitHub connection may be read-only and does not, by itself, create automatic model-to-model messaging.

### Claude Code — Lead developer

Claude Code is responsible for:
- Inspecting the current code and relevant documentation before changing anything.
- Implementing approved requirements in the appropriate repository.
- Preserving existing working functionality and established UI patterns unless a change is explicitly requested.
- Creating a focused feature or documentation branch; never working directly on a protected/default branch.
- Running relevant tests, lint, type checks, and builds; reporting exact commands and outcomes.
- Updating documentation when behavior, APIs, configuration, or architecture changes.
- Opening a pull request with scope, implementation summary, test evidence, risks, and deployment/migration notes.

Claude must not claim a test passed unless it was actually run and passed.

### Project owner — final authority

The project owner decides priorities and scope, approves material architecture or product changes, reviews pull requests, and authorizes merges, production deployments, data migrations, and other sensitive operations.

Neither AI assistant may merge or deploy without explicit project-owner approval.

## 3. Project context and source of truth

- Frontend repository: `Theoneste1/ROFFRONTENDTEST` (default branch: `main`).
- Backend repository: `Theoneste1/ROFBACKENDTEST` (default branch: `develop`).
- Frontend: Next.js App Router, React, TypeScript, Tailwind CSS, TanStack Query. The frontend proxies `/api/*` requests to the backend.
- Backend: NestJS, TypeScript, PostgreSQL, Prisma; REST API under `/api/v1`; OpenAPI documentation under `/api/docs`.
- The backend API contract and backend architecture/workflow documentation are authoritative for API behavior. The existing frontend is the UI/UX reference unless the owner approves a redesign.
- Consult the current README and relevant project documentation before relying on this summary. Code and current approved requirements take precedence over stale summaries.

### Current product baseline

- The current learning focus is Mathematics.
- Mathematics topics/courses: Algebra, Geometry, Number Theory, and Combinatorics.
- Divisions: Junior (S1–S3) and Senior (S4–S6).
- Student, mentor, and administrator roles have distinct permissions and scopes.
- Physics and Computing may be considered for future expansion; do not add them or change the course model without an approved requirement.
- Do not reintroduce explicitly excluded or deferred features merely because they appear in old plans or code. Confirm against the latest owner-approved requirements.

## 4. Non-negotiable engineering rules

1. **Inspect before editing.** Read the relevant implementation, tests, API contract, and project notes first.
2. **No destructive shortcuts.** Do not delete, reset, rewrite history, force-push, or replace existing work unless the owner explicitly approves the exact action.
3. **No direct default-branch changes.** Work through branches and pull requests.
4. **No secrets in Git.** Never commit credentials, tokens, private keys, production environment files, personal data, or database dumps. Use environment variables and documented secret stores.
5. **Security is enforced server-side.** Frontend role-based hiding is not authorization. Preserve backend guards, ownership checks, division scoping, validation, and audit behavior.
6. **Respect API contracts.** Do not invent endpoints or request/response fields. Check backend source/OpenAPI docs and coordinate frontend/backend changes.
7. **Preserve data integrity.** Treat schema changes and migrations as high-risk. Explain rollback/backup implications and obtain owner approval before production migration.
8. **Keep changes focused.** Avoid unrelated refactors, dependency upgrades, or broad formatting changes in a feature PR.
9. **Test honestly.** Separate passed, failed, skipped, and not-run checks. Include blockers and environment limitations.
10. **Protect student information.** Use synthetic/test data in development and avoid exposing student personal information in logs, screenshots, issues, or AI prompts.

## 5. Standard collaboration workflow

1. **Request:** The owner describes the goal or approves a task.
2. **GPT planning:** GPT reviews the relevant context and writes a task brief with scope, constraints, acceptance criteria, affected repositories, and risks.
3. **Claude implementation:** Claude inspects the code, implements on a new branch, and runs relevant checks.
4. **Pull request:** Claude opens a PR against the correct base branch and includes test evidence and any cross-repository dependency.
5. **GPT review:** GPT independently reviews the diff and evidence. Findings must be classified as:
   - **Blocker:** security, data loss, broken core flow, or release-stopping defect.
   - **Major:** important functional, authorization, API-contract, or reliability issue.
   - **Minor:** non-blocking defect or maintainability concern.
   - **Suggestion:** optional improvement.
6. **Revision:** Claude addresses findings or explains why a finding does not apply. Material disagreements are referred to the owner.
7. **Owner approval:** The owner reviews the final diff, CI, and review status, then decides whether to merge.
8. **Release:** Deployment and production migrations happen only after explicit owner authorization. Verify the deployed result and report it.

## 6. Pull request checklist

Every implementation PR should state:
- What changed and why.
- Which approved requirement/task it satisfies.
- Repositories, routes, modules, database tables, or API contracts affected.
- Tests/checks run, with exact commands and results.
- Tests not run and why.
- Security, privacy, authorization, and data-integrity considerations.
- Required environment variables, migrations, storage, or deployment changes.
- Rollback or recovery considerations for risky changes.
- Screenshots or recordings for material UI changes, using synthetic data.

## 7. Communication and handoff format

When handing work from Claude to GPT, provide the PR URL and a concise report:

```text
TASK:
PR:
REPOSITORY / BRANCH:
SUMMARY:
FILES OR MODULES CHANGED:
TESTS RUN:
TEST RESULTS:
KNOWN LIMITATIONS:
MIGRATIONS / CONFIGURATION:
QUESTIONS FOR REVIEW:
```

GPT's review should return:
- Overall assessment: approve for owner review / changes requested / blocked.
- Findings ordered by severity, each with file path and line/reference where possible.
- Missing tests and unverified claims.
- Any cross-repository compatibility concerns.
- A concise recommendation for Claude's next action.

## 8. Automation and cost boundary

The initial collaboration must use existing Claude Code and ChatGPT interfaces plus GitHub as the shared workspace. Do not add paid API usage, paid automation services, or new infrastructure without the owner's explicit approval.

GitHub events and CI can automate repository checks and notifications. They do not automatically grant a ChatGPT or Claude subscription the ability to invoke that model programmatically. Any future model-to-model automation must use officially supported access, be cost-capped, protect secrets, and be approved by the owner before activation.

## 9. Definition of done

A task is complete only when:
- The approved acceptance criteria are met.
- Relevant tests and checks have been run and their results recorded.
- GPT review findings are resolved or explicitly accepted by the owner.
- Documentation is updated where necessary.
- The owner has approved the PR and any release/migration action.
- Production behavior is verified if a deployment was authorized.

---
This protocol is a collaboration guide, not a substitute for current code, security controls, approved requirements, or the project owner's decisions.

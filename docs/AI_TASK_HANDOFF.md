# ROF LMS — AI Task Handoff

Use this workflow for every meaningful feature, bug fix, refactor, documentation task, or deployment-readiness task. This process is designed for GPT + Claude Code + GitHub without requiring paid model APIs.

## Workflow

1. **Create a task brief.** The project owner or GPT records the task as a GitHub issue using the AI Task template. The brief must link the relevant requirements and identify the target repository.
2. **Clarify before coding.** GPT checks the task against current approved requirements, architecture, and existing code. Missing critical information is raised before implementation.
3. **Implement.** The owner gives Claude Code the approved task and issue link. Claude reads this handoff document and the collaboration protocol, inspects the repository, and works on a focused branch.
4. **Report.** Claude opens a PR linked to the issue and completes the PR template, including test evidence and limitations.
5. **Review.** GPT reviews the PR diff and evidence independently. GPT reports findings with severity, file path, and actionable correction.
6. **Fix and re-review.** Claude addresses findings. GPT checks the updated diff. Repeat until no unresolved blocker or major finding remains.
7. **Approve and release.** The owner makes the final merge and deployment decisions. Do not merge or deploy on behalf of the owner.

## Task status vocabulary

Use these labels/statuses in issue comments or handoff reports:
- **Proposed:** request captured, not yet approved for implementation.
- **Ready:** scope and acceptance criteria are clear; owner approved implementation.
- **In progress:** Claude is implementing.
- **In review:** PR is open and awaiting independent review.
- **Changes requested:** review found issues to address.
- **Owner approval:** technical review is complete; waiting for owner decision.
- **Done:** merged and verified to the extent stated in the completion report.
- **Blocked:** progress depends on a decision, access, external service, or unresolved defect.

## GPT task brief format

```text
TASK ID / ISSUE:
TITLE:
TARGET REPOSITORY:
RELATED PR / ISSUE:
WHY THIS IS NEEDED:
CURRENT BEHAVIOUR:
EXPECTED BEHAVIOUR:
IN SCOPE:
OUT OF SCOPE:
REQUIREMENTS / REFERENCES:
ACCEPTANCE CRITERIA:
SECURITY / DATA / PERMISSIONS:
DEPENDENCIES:
TEST EXPECTATIONS:
OWNER DECISION REQUIRED:
```

## Claude implementation handoff

```text
ISSUE:
PR:
REPOSITORY:
BRANCH:
IMPLEMENTATION SUMMARY:
FILES / MODULES CHANGED:
API / DATABASE / UI IMPACT:
TEST COMMANDS RUN:
TEST RESULTS:
CHECKS NOT RUN AND WHY:
SECURITY / AUTHORIZATION NOTES:
MIGRATIONS / ENVIRONMENT CHANGES:
KNOWN LIMITATIONS:
MANUAL TEST STEPS:
```

## GPT review report

```text
PR:
REVIEW RESULT: APPROVE FOR OWNER REVIEW / CHANGES REQUESTED / BLOCKED

FINDINGS:
- [BLOCKER | MAJOR | MINOR | SUGGESTION] file:line — issue and impact — recommended fix

MISSING TESTS:
API / FRONTEND / BACKEND COMPATIBILITY:
SECURITY / DATA-INTEGRITY CONCERNS:
UNVERIFIED CLAIMS:
RECOMMENDED NEXT ACTION:
```

## Rules for cross-repository tasks

- If a change requires both frontend and backend work, create or link a task in both repositories and identify the dependency order.
- Agree on the API contract before implementing both sides. The backend OpenAPI specification and current API implementation are the contract.
- Merge backend changes before frontend changes when the frontend depends on a newly introduced backend contract, unless a backward-compatible rollout plan says otherwise.
- Include both PR links in each handoff. Do not assume two separate PRs are compatible merely because both pass their own tests.
- Never put secrets, real student records, or production database contents in issues, PRs, logs, or AI prompts.

## Cost and automation

The initial workflow is manual and uses existing ChatGPT/Claude interfaces with GitHub as the shared record. GitHub issue/PR templates standardize handoffs; they do not cause GPT and Claude subscription sessions to message each other automatically. Do not add model API keys, paid services, or automated model calls without explicit owner approval.

## Definition of done

A task is done only when acceptance criteria are met, test evidence is recorded, required review findings are resolved or accepted by the owner, documentation is updated, the owner approves merge/release, and any authorized deployment is verified.

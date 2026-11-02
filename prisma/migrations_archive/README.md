# Archived migrations (do not apply)

These 16 migrations are the original history of the project, kept for reference.

They were retired on 2026-11-03 because the chain could not build a database:
`20261015150000_add_courses` runs `CREATE TABLE "Course"` although
`20260921101458_add_course_model` already created that table, so
`prisma migrate deploy` failed on an empty database (error 42P07). The chain had
also drifted from `schema.prisma` (cascade rules, column defaults, indexes).

No live database had ever been built from this history, so it was replaced by
a single baseline migration in `prisma/migrations/` generated from the
current schema. Prisma does not read this folder.

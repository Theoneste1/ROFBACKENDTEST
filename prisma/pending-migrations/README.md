# Pending migrations (require approval)

Destructive migrations are prepared here and applied only after explicit
approval. `prisma migrate deploy` does not read this folder.

**Currently none are pending.**

## Procedure for a destructive migration

1. Describe its impact (what is dropped, where the data lives instead,
   reversibility) and ask for approval.
2. Take a database backup.
3. Make the migration verify its preconditions and abort (changing nothing)
   when they do not hold.
4. Rehearse it on a disposable copy of the database.
5. Move the folder into `prisma/migrations/` with a timestamp later than the
   last applied migration, update `schema.prisma`, run `npx prisma generate`.
6. `npm run db:migrate`, then confirm
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
   reports no difference.

## History

| Migration | Approved | Applied |
|---|---|---|
| `20261107000000_drop_superseded_columns` — drops the old single-file, review and comment-target columns | 2026-11-03 | 2026-11-03, after a full backup; data verified identical before and after |

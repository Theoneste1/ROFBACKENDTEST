# ROF LMS — File storage

All uploads and downloads go through `StorageService`
(`src/common/storage/`). No other code reads or writes files.

## What is stored

| Purpose | Uploaded by | Allowed types (detected) | Max per file |
|---|---|---|---|
| `SUBMISSION` | students | PDF, JPEG, PNG, WebP, GIF, HEIC/HEIF, DOC/DOCX, ZIP, plain text | 20 MB |
| `FEEDBACK` | the reviewing mentor | PDF, images, DOC/DOCX, plain text | 10 MB |
| `ASSIGNMENT_BRIEF` | the mentor preparing the assignment | PDF, images, DOC/DOCX, ZIP, plain text | 20 MB |
| `RESOURCE` | mentors (own scopes) and admins | the above + PPT/PPTX, EPUB | 50 MB |

At most 10 files per upload request (`files`, or one `file`), and a whole
request is capped at `MAX_UPLOAD_REQUEST_MB` (default 100 MB). Requests over
the cap are refused before their body is read (`413 PAYLOAD_TOO_LARGE`). Set
the same limit in the reverse proxy.

## Upload pipeline

1. Multer holds the files in memory. Nothing is written until the request is
   authorized: the caller's role and scope are checked first.
2. The type is detected from the file's bytes (`file-type`), never from the
   name or the browser's Content-Type. Text without NUL bytes is treated as
   `text/plain`. Anything not on the purpose's allow-list is refused
   (`415 FILE_TYPE_NOT_ALLOWED`); executables, HTML and SVG can never be
   stored as such.
3. Size is checked against the purpose's limit (`413 FILE_TOO_LARGE`).
4. The file is stored under a fresh random key,
   `<folder>/<year>/<month>/<uuid>.<detected ext>`. User input never becomes
   part of a storage path. The local driver also refuses any key that would
   resolve outside its root.
5. A `FileObject` row records the key, original name (stripped of path parts
   and control characters), detected type, size and SHA-256. Attachment rows
   link it to its owner (submission revision, review, assignment, resource).

## Download

Downloads always go through an endpoint that checks access first, for example:

| File | Who may download |
|---|---|
| Submission files (any revision) | the student, the mentor currently assigned, admins |
| Feedback files | the reviewing mentor and admins; the student only after publication |
| Assignment brief | mentors of the scope and admins; students once published |
| Resource files | mentors of the scope and admins; students of the division once published |

Every response carries:
- `Content-Type`: the stored, detected type;
- `Content-Disposition`: `inline` only for PDF and images, otherwise
  `attachment`. File names are RFC 5987-encoded with an ASCII fallback, so they
  can't inject headers;
- `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`;
- `Content-Security-Policy: default-src 'none'; …; sandbox`, so even a file
  opened in the browser cannot run scripts against the API's origin.

## Drivers

| `STORAGE_DRIVER` | Use | Settings |
|---|---|---|
| `local` (default) | one instance, development | `UPLOAD_DIR` (default `./storage`) |
| `s3` | production, several instances | `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (R2/MinIO), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (MinIO) |

The S3 driver streams objects through the API, so access checks always apply;
there are no public or pre-signed URLs. The bucket should be private. The
health check (`GET /health`) also checks that storage is reachable. To prove an
upload and byte-identical download against the real bucket, see
[operations/R2-VERIFICATION.md](operations/R2-VERIFICATION.md) (`npm run storage:verify`).

## Lifecycle and cleanup

- Submissions keep every revision's files. Reviews keep their feedback files.
  Neither is deleted by the application.
- Removing an attachment, or deleting a resource, unlinks the file. A nightly
  job (03:00) deletes stored files that nothing references and that are older
  than 24 hours, up to 500 per run.
- Back up the bucket (enable versioning) or the `UPLOAD_DIR` volume together
  with the database. A database restore without the matching files leaves
  attachments that can't be downloaded.

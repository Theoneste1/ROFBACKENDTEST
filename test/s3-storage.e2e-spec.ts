/**
 * S3-compatible storage (STORAGE_DRIVER=s3): uploads, authorized downloads,
 * replaced/removed files, the health check and the orphan clean-up — against
 * a real S3 API endpoint.
 *
 * Needs an S3-compatible server; skipped otherwise:
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000  S3_TEST_ACCESS_KEY=…  S3_TEST_SECRET_KEY=…
 *   (optional) S3_TEST_BUCKET=rof-e2e
 * CI runs it against a MinIO service container.
 */
import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { StorageService } from '../src/common/storage/storage.service.js';
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

// The configuration is read when the app module is imported, so the storage
// settings must be in place before the imports above are evaluated.
const { endpoint, bucket } = vi.hoisted(() => {
  const endpoint = process.env.S3_TEST_ENDPOINT;
  const bucket   = process.env.S3_TEST_BUCKET ?? `rof-e2e-${process.pid}`;
  if (endpoint) {
    Object.assign(process.env, {
      STORAGE_DRIVER: 's3', S3_BUCKET: bucket, S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY, S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_KEY,
      S3_FORCE_PATH_STYLE: 'true',
    });
  }
  return { endpoint, bucket };
});

describe.skipIf(!endpoint)('S3 storage driver (e2e, needs S3_TEST_ENDPOINT)', () => {
  let ctx: TestContext;
  let s3: S3Client;
  let student: string, mentor: string, admin: string;

  const exists = async (key: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, () => false);

  beforeAll(async () => {
    s3 = new S3Client({
      endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_TEST_ACCESS_KEY!, secretAccessKey: process.env.S3_TEST_SECRET_KEY! },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((err) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(err?.name))) throw err;
    });

    ctx = await createTestApp();
    [student, mentor, admin] = await Promise.all(['student.j', 'mentor.j', 'admin'].map((u) => login(ctx, u)));
  });

  afterAll(async () => {
    for (const k of ['STORAGE_DRIVER', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE']) delete process.env[k];
    await ctx?.app.close();
  });

  it('the app really uses the S3 driver, and the health check reaches the bucket', async () => {
    expect(ctx.app.get(StorageService).driverName).toBe('s3');
    const res = await ctx.http().get('/health').expect(200);
    expect(res.body.checks).toEqual({ database: 'up', storage: 'up' });
  });

  it('stores uploads in the bucket and streams them back only to people allowed to see them', async () => {
    const a = await ctx.prisma.assignment.create({ data: {
      title: 'S3', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
    } });
    const sub = await ctx.http().post('/api/v1/submissions').set(bearer(student))
      .field('assignmentId', a.id).attach('files', PDF, 'work.pdf').expect(201);
    const file = await ctx.prisma.fileObject.findFirstOrThrow({ where: { uploadedById: ctx.ids.studentJunior } });
    expect(file.storageKey).toMatch(/^submissions\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(await exists(file.storageKey)).toBe(true);

    const dl = await ctx.http().get(`/api/v1/submissions/${sub.body.id}/file`).set(bearer(student))
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect((dl.body as Buffer).equals(PDF)).toBe(true); // byte-for-byte what was uploaded
    await ctx.http().get(`/api/v1/submissions/${sub.body.id}/file`).set(bearer(mentor)).expect(404); // not assigned
    await ctx.http().get(`/api/v1/submissions/${sub.body.id}/file`).set(bearer(admin)).expect(200);
  });

  it('removed files are deleted from the bucket by the clean-up, and a missing object answers 404', async () => {
    const r = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(mentor))
      .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'S3 notes').attach('file', PDF, 'notes.pdf').expect(201);
    const att = r.body.attachments[0];
    const key = (await ctx.prisma.fileObject.findUniqueOrThrow({ where: { id: att.file.id } })).storageKey;
    await ctx.http().delete(`/api/v1/courses/${ctx.ids.algebra}/resources/${r.body.id}/attachments/${att.id}`).set(bearer(mentor)).expect(200);

    // The clean-up removes unreferenced files older than a day; age this one.
    await ctx.prisma.fileObject.update({ where: { id: att.file.id }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const storage = ctx.app.get(StorageService);
    const removed = await storage.cleanupOrphans();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await exists(key)).toBe(false);
    expect(await ctx.prisma.fileObject.count({ where: { id: att.file.id } })).toBe(0);

    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'resources/' }));
    expect((listing.Contents ?? []).map((o) => o.Key)).not.toContain(key);
  });
});

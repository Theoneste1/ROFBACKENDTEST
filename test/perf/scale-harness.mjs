#!/usr/bin/env node
/**
 * Scale measurements (NOT part of CI): runs the REAL service code paths of a compiled backend
 * (`nest build` output) in a Nest application context against a database seeded by
 * seed-scale.mjs, and records wall time, rows, memory and the slowest SQL statements of each one.
 *
 *   node test/perf/scale-harness.mjs --dist <dist dir> --db <url> --label <name> --out <file.jsonl>
 *        [--ops dashboard,overview,...] [--explain] [--no-capture]
 *
 * Writes one JSON line per operation. Destructive operations (distribute, publish, recompute,
 * rollover) change the database: run them last, on a copy of the seeded database.
 * Run it from an empty working directory (ConfigModule reads ./.env when present).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const dist = resolve(args.dist);
const dbUrl = args.db;
const dbName = new URL(dbUrl).pathname.slice(1);
if (!/^rof_(e|perf)_[a-z0-9_]+$/.test(dbName)) throw new Error(`refusing ${dbName}: not a disposable rof_e_/rof_perf_ database`);
const ALL_OPS = ['dashboard', 'overview', 'activeUsers', 'analytics', 'leaderboardMine', 'leaderboardPage', 'assignmentReport',
  'userSearch', 'resultsCsv', 'studentsCsv', 'distribute', 'publishAll', 'recompute', 'rollover'];
const ops = args.ops ? args.ops.split(',') : ALL_OPS;

// ─── Environment (before the app is imported) ────────────────────────────────
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: dbUrl,
  JWT_SECRET: 'scale-harness-secret-that-is-long-enough-0123456789',
  WORKERS_ENABLED: 'false',
  STORAGE_DRIVER: 'local',
  UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'rof-perf-')),
  THROTTLE_DISABLED: 'true',
  APP_URL: 'http://localhost:5173',
  RESEND_API_KEY: '', RESEND_BASE_URL: '', EMAIL_REDIRECT_TO: '', EMAIL_FROM: '', EMAIL_REPLY_TO: '',
});

// ─── SQL capture: every statement the application sends, with its duration ───
const requireFromDist = createRequire(join(dist, 'main.js'));
const pg = requireFromDist('pg');
let capture = null;
for (const proto of [pg.Client.prototype]) {
  const original = proto.query;
  proto.query = function patched(config, values, cb) {
    const text = typeof config === 'string' ? config : config?.text;
    const params = typeof config === 'object' && config?.values ? config.values : Array.isArray(values) ? values : undefined;
    const started = process.hrtime.bigint();
    if (!capture || !text) return original.call(this, config, values, cb);
    const rec = { text, params, ms: 0 };
    capture.push(rec);
    const done = (err, r) => { rec.ms = Number(process.hrtime.bigint() - started) / 1e6; rec.rows = r?.rowCount; if (err) rec.failed = true; };
    // Callback style (pg.Pool#query uses it) or promise style.
    if (typeof values === 'function') return original.call(this, config, (err, r) => { done(err, r); values(err, r); });
    if (typeof cb === 'function') return original.call(this, config, values, (err, r) => { done(err, r); cb(err, r); });
    if (typeof config?.callback === 'function') {
      const inner = config.callback;
      config.callback = (err, r) => { done(err, r); inner(err, r); };
      return original.call(this, config, values, cb);
    }
    const out = original.call(this, config, values, cb);
    if (out && typeof out.then === 'function') out.then((r) => done(null, r), (e) => done(e));
    return out;
  };
}

const imp = (p) => import(pathToFileURL(join(dist, p)).href);
const { NestFactory } = await import(pathToFileURL(requireFromDist.resolve('@nestjs/core')).href);
const { AppModule } = await imp('app/app.module.js');
const { PrismaService } = await imp('prisma/prisma.service.js');
const services = {
  years:      (await imp('academic-years/academic-years.service.js')).AcademicYearsService,
  submissions:(await imp('submissions/submissions.service.js')).SubmissionsService,
  analytics:  (await imp('analytics/analytics.service.js')).AnalyticsService,
  dashboard:  (await imp('reports/dashboard.service.js')).DashboardService,
  reports:    (await imp('reports/reports.service.js')).ReportsService,
  userReports:(await imp('reports/user-reports.service.js')).UserReportsService,
  academic:   (await imp('reports/academic-reports.service.js')).AcademicReportsService,
  activity:   (await imp('activity/activity.service.js')).ActivityService,
  leaderboard:(await imp('leaderboard/leaderboard.service.js')).LeaderboardService,
  users:      (await imp('users/users.service.js')).UsersService,
};
const { csvLine } = await imp('reports/csv.js');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
const get = (k) => app.get(services[k]);
const prisma = app.get(PrismaService);

// Event handlers (notifications, e-mails) run after the call returns: track them to time the tail.
const pending = new Set();
const { ModulesContainer } = await import(pathToFileURL(requireFromDist.resolve('@nestjs/core')).href);
for (const module of app.get(ModulesContainer).values()) {
  for (const wrapper of module.providers.values()) {
    const loader = wrapper.instance;
    if (loader?.constructor?.name !== 'EventSubscribersLoader' || !loader.wrapFunctionInTryCatchBlocks) continue;
    const original = loader.wrapFunctionInTryCatchBlocks.bind(loader);
    loader.wrapFunctionInTryCatchBlocks = (...a) => {
      const done = Promise.resolve(original(...a)).then(() => undefined, () => undefined);
      pending.add(done); void done.then(() => pending.delete(done));
      return done;
    };
  }
}
const drainEvents = async () => {
  do { await new Promise((r) => setImmediate(r)); await Promise.allSettled(pending); } while (pending.size);
};

// ─── Fixtures from the seed ──────────────────────────────────────────────────
const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const admin = { id: ADMIN_ID, username: 'admin', role: 'ADMIN', divisionId: null, gradeLevel: null, overrides: [] };
const YEAR1 = '00000000-0000-4000-8000-0000000000e1';
const YEAR2 = '00000000-0000-4000-8000-0000000000e2';
const ALGEBRA = '00000000-0000-4000-8000-0000000000c1';
const SENIOR = '00000000-0000-4000-8000-00000000a002';
const BIG_PUBLISH = '00000000-0000-4000-8000-0000000000b1';
const BIG_DISTRIBUTE = '00000000-0000-4000-8000-0000000000b2';
const someStudent = await prisma.user.findFirstOrThrow({
  where: { role: 'STUDENT', isActive: true, divisionId: SENIOR }, orderBy: { username: 'asc' },
  select: { id: true, username: true, role: true, divisionId: true, gradeLevel: true },
});
const student = { ...someStudent, overrides: [] };

const countCsv = async (exp) => {
  let rows = 0, bytes = Buffer.byteLength(csvLine(exp.headers));
  for await (const batch of exp.batches) { rows += batch.length; for (const r of batch) bytes += Buffer.byteLength(csvLine(r)); }
  return { rows, bytes };
};

const OPS = {
  dashboard:        async () => ({ students: (await get('dashboard').dashboard({}, admin)).students.total }),
  overview:         async () => ({ activeUsers: (await get('reports').overview()).activeUsers }),
  activeUsers:      async () => {
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86_400_000);
    return { activeUsers: (await get('activity').summary(from, to, admin)).activeUsers };
  },
  analytics:        async () => {
    const r = await get('analytics').courseAnalytics(ALGEBRA, SENIOR, admin);
    return { students: r.students.total, assignments: r.assignments.length, publishedResults: r.assignments.reduce((n, a) => n + a.publishedResults, 0) };
  },
  leaderboardMine:  async () => { const r = await get('leaderboard').findMine(student); return { rank: r.rank, outOf: r.outOf }; },
  leaderboardPage:  async () => { const r = await get('leaderboard').findGeneral(admin, { divisionId: SENIOR, page: 1, limit: 20 }); return { total: r.meta.total }; },
  assignmentReport: async () => { const r = await get('academic').assignments({}, admin); return { assignments: r.summary.assignments, submissions: r.summary.submissions }; },
  userSearch:       async () => {
    const a = await get('users').findAll({ search: 'mugisha', page: 1, limit: 20 });
    const b = await get('users').findAll({ search: 'student4242@', page: 1, limit: 20 });
    return { matches: a.meta.total, exact: b.meta.total };
  },
  resultsCsv:       async () => countCsv(await get('reports').resultsCsv({ courseId: ALGEBRA, divisionId: SENIOR })),
  studentsCsv:      async () => countCsv(await get('userReports').studentsCsv({}, admin)),
  distribute:       async () => { const r = await get('submissions').distribute(BIG_DISTRIBUTE, {}, admin); return { distributed: r.distributed, strategy: r.strategy }; },
  publishAll:       async () => { const r = await get('submissions').publishAssignmentResults(BIG_PUBLISH, admin); return { published: r.published }; },
  recompute:        async () => get('submissions').recomputeAllPoints(admin),
  rollover:         async () => {
    const r = await get('years').activate(YEAR2, { promoteStudents: true, deactivateGraduates: true, expectedCurrentYearId: YEAR1 }, admin);
    const { academicYear: _year, ...counts } = r;
    return counts;
  },
};
const EVENTFUL = new Set(['distribute', 'publishAll']);

const out = args.out;
const record = (o) => { const line = JSON.stringify({ label: args.label, db: dbName, at: new Date().toISOString(), ...o }); console.log(line); if (out) appendFileSync(out, line + '\n'); };

const rowCounts = await prisma.$queryRawUnsafe(`SELECT
  (SELECT count(*) FROM "User" WHERE role = 'STUDENT')::int AS students,
  (SELECT count(*) FROM "User" WHERE role = 'STUDENT' AND "isActive")::int AS "activeStudents",
  (SELECT count(*) FROM "Submission")::int AS submissions,
  (SELECT count(*) FROM "MentorReview")::int AS reviews,
  (SELECT count(*) FROM "ActivityLog")::int AS activity,
  (SELECT count(*) FROM "Submission" WHERE "assignmentId" = '${BIG_PUBLISH}' AND status = 'APPROVED')::int AS "bigPublishApproved",
  (SELECT count(*) FROM "Submission" WHERE "assignmentId" = '${BIG_DISTRIBUTE}' AND status = 'SUBMITTED')::int AS "bigDistributeSubmitted"`);
record({ op: 'dataset', ...rowCounts[0] });

const explainPg = new pg.Client({ connectionString: dbUrl.replace(/\?.*$/, '') });
await explainPg.connect();

for (const op of ops) {
  if (global.gc) global.gc();
  const base = process.memoryUsage();
  let peakRss = base.rss, peakHeap = base.heapUsed;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 25);
  capture = args['no-capture'] ? null : [];   // --no-capture: memory runs (the capture keeps every statement)
  const started = performance.now();
  let result, error;
  try { result = await OPS[op](); } catch (e) { error = `${e?.code ?? e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}`; }
  const ms = performance.now() - started;
  let tailMs = null;
  if (EVENTFUL.has(op) && !error) { const t = performance.now(); await drainEvents(); tailMs = Math.round(performance.now() - t); }
  clearInterval(sampler);
  const statements = capture ?? []; capture = null;
  const sqlMs = statements.reduce((s, q) => s + q.ms, 0);
  const slowest = [...statements].sort((a, b) => b.ms - a.ms).slice(0, 3);
  let explain;
  if (args.explain && slowest[0] && slowest[0].ms > 200 && /^\s*(SELECT|WITH)/i.test(slowest[0].text) && !/FOR UPDATE|pg_advisory/i.test(slowest[0].text)) {
    try {
      const plan = await explainPg.query(`EXPLAIN (ANALYZE, BUFFERS) ${slowest[0].text}`, slowest[0].params);
      explain = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    } catch (e) { explain = `EXPLAIN failed: ${e.message}`; }
  }
  record({
    op, ms: Math.round(ms), tailMs, error, result,
    statements: statements.length, sqlMs: Math.round(sqlMs),
    rssPeakMB: Math.round(peakRss / 1048576), rssDeltaMB: Math.round((peakRss - base.rss) / 1048576), heapPeakMB: Math.round(peakHeap / 1048576),
    slowest: slowest.map((q) => ({ ms: Math.round(q.ms), rows: q.rows, sql: q.text.replace(/\s+/g, ' ').slice(0, 400) })),
    ...(explain && { explain }),
  });
}

await explainPg.end();
await app.close();
process.exit(0);

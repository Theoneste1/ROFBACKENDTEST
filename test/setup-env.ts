/**
 * Environment for e2e tests. Runs before any application module is imported.
 *
 * TEST_DATABASE_URL must point to a disposable database: every test file
 * truncates all tables. The suite refuses to run without it so the
 * development database (DATABASE_URL) is never wiped by accident.
 */
import 'dotenv/config';
import { join } from 'path';
import { tmpdir } from 'os';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Point it at a disposable PostgreSQL database ' +
    '(e.g. `npx prisma dev --name rof-test`) — the e2e suite truncates every table.',
  );
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
}

process.env.NODE_ENV        = 'test';
process.env.DATABASE_URL    = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET      = 'e2e-test-secret-that-is-long-enough-123456';
process.env.STORAGE_DRIVER  = 'local';
process.env.UPLOAD_DIR      = join(tmpdir(), `rof-e2e-${process.pid}`);
process.env.WORKERS_ENABLED = 'false';   // tests drive workers explicitly
process.env.THROTTLE_DISABLED = 'true';
process.env.APP_URL         = 'http://localhost:5173';
// E-mail never leaves the machine in tests: dry run, no redirect, no real
// sender. Set to empty rather than deleted — the app's ConfigModule fills
// variables that are MISSING from process.env with the values in .env (which
// may hold a real Resend key); an empty value counts as "not set".
for (const key of ['RESEND_API_KEY', 'RESEND_BASE_URL', 'EMAIL_REDIRECT_TO', 'EMAIL_FROM', 'EMAIL_REPLY_TO']) process.env[key] = '';

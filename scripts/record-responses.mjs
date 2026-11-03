#!/usr/bin/env node
/**
 * Runs the end-to-end suite while recording the schema of every JSON response
 * (docs/api/response-schemas.json), then regenerate the docs with
 * `npm run docs:api` to put them into the OpenAPI file and Postman collection.
 * Needs TEST_DATABASE_URL like `npm run test:e2e`.
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const result = spawnSync('npx', ['vitest', 'run', '--config', './vitest.config.e2e.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env:   { ...process.env, RECORD_API_RESPONSES: join(tmpdir(), `rof-responses-${process.pid}`) },
});
process.exit(result.status ?? 1);

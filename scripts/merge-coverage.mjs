#!/usr/bin/env node
/**
 * Combined code coverage of the unit and end-to-end suites.
 *
 *   npm run test:coverage:all
 *
 * Runs both suites with coverage (the e2e suite needs TEST_DATABASE_URL),
 * merges their Istanbul reports and prints the totals and the least-covered
 * files. Each suite alone under-reports: unit tests cover rules, e2e tests
 * cover the HTTP and database paths.
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';

const root = process.cwd();
const out = join(tmpdir(), `rof-coverage-${process.pid}`);
const common = "--coverage --coverage.reporter=json --coverage.include='src/**/*.ts' --coverage.exclude='src/generated/**' --coverage.exclude='src/**/*.spec.ts'";

for (const [name, cfg] of [['unit', ''], ['e2e', '--config ./vitest.config.e2e.ts']]) {
  console.log(`Running ${name} tests with coverage…`);
  execSync(`npx vitest run ${cfg} ${common} --coverage.reportsDirectory="${join(out, name)}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
}

const map = libCoverage.createCoverageMap({});
for (const name of ['unit', 'e2e']) map.merge(JSON.parse(readFileSync(join(out, name, 'coverage-final.json'), 'utf8')));
rmSync(out, { recursive: true, force: true });

const pct = (s) => `${s.pct.toFixed(1)}%`.padStart(6);
const total = map.getCoverageSummary();
console.log(`\nCombined coverage: lines ${pct(total.lines)} · branches ${pct(total.branches)} · functions ${pct(total.functions)} · statements ${pct(total.statements)}\n`);

const files = map.files().map((f) => ({ f: relative(root, f), s: map.fileCoverageFor(f).toSummary() }))
  .filter((x) => x.s.lines.total >= 15)
  .sort((a, b) => a.s.lines.pct - b.s.lines.pct);
console.log('Least covered files (lines · branches):');
for (const { f, s } of files.slice(0, Number(process.env.SHOW ?? 15))) console.log(`  ${pct(s.lines)} · ${pct(s.branches)}  ${f}`);

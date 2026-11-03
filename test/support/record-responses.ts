/**
 * Global setup/teardown for `npm run docs:responses`: clears the recording
 * folder before the e2e run and, afterwards, merges what every test file
 * recorded into docs/api/response-schemas.json (sorted, so it only changes
 * when the API's responses do).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSchemas, sortSchema, type Schema } from './response-schema.js';

export function setup() {
  const dir = process.env.RECORD_API_RESPONSES;
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  return () => {
    const merged = new Map<string, Schema>();
    for (const file of readdirSync(dir).filter((f) => f.startsWith('part-'))) {
      const part = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, Schema>;
      for (const [key, schema] of Object.entries(part)) merged.set(key, mergeSchemas(merged.get(key), schema));
    }
    // Success responses only: every error has the same shape, documented once
    // as the Error schema. Nest's catch-all "not found" route is not an endpoint.
    const keep = [...merged.keys()].filter((k) => /\s[23]\d\d$/.test(k) && !k.includes('*')).sort();
    const out = Object.fromEntries(keep.map((k) => [k, sortSchema(merged.get(k)!)]));
    writeFileSync(join(process.cwd(), 'docs/api/response-schemas.json'), JSON.stringify(out, null, 2) + '\n');
    rmSync(dir, { recursive: true, force: true });
    console.log(`Recorded response schemas for ${keep.length} successful route/status combinations → docs/api/response-schemas.json`);
  };
}

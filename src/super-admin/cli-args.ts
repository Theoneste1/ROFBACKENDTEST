/** Argument parsing and entry check of the Super Admin operator command (src/super-admin/cli.ts). Pure; unit-tested. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Flags that take no value (present = "true"). */
export const BOOLEAN_FLAGS: readonly string[] = ['dry-run'];

export function parseArgs(argv: string[]) {
  const [command, maybeMode, ...rest] = argv;
  const flags: Record<string, string> = {};
  const list = command === 'break-glass' ? rest : [maybeMode, ...rest].filter((x) => x !== undefined);
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (!k?.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
    if (BOOLEAN_FLAGS.includes(k.slice(2))) { flags[k.slice(2)] = 'true'; continue; }
    const v = list[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${k}`);
    flags[k.slice(2)] = v; i++;
  }
  if (flags['dry-run'] && command !== 'bootstrap') throw new Error('--dry-run is only for bootstrap');
  return { command, mode: command === 'break-glass' ? maybeMode : undefined, flags };
}

/** True when this file is the program Node was started with (any extension or path form). */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return !!argv1 && moduleUrl === pathToFileURL(resolve(argv1)).href;
}

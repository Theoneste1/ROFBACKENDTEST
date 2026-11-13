import { parseArgs } from './cli-args.js';

describe('super-admin CLI arguments', () => {
  it('bootstrap flags', () => {
    expect(parseArgs(['bootstrap', '--username', 'owner', '--confirm-username', 'owner', '--reason', 'first owner'])).toEqual({
      command: 'bootstrap', mode: undefined, flags: { username: 'owner', 'confirm-username': 'owner', reason: 'first owner' },
    });
  });

  it('break-glass mode and flags', () => {
    expect(parseArgs(['break-glass', 'promote-admin', '--username', 'a', '--reason', 'lost access', '--approval-ref', 'APR-9'])).toEqual({
      command: 'break-glass', mode: 'promote-admin', flags: { username: 'a', reason: 'lost access', 'approval-ref': 'APR-9' },
    });
  });

  it.each([
    [['bootstrap', 'owner']],
    [['bootstrap', '--username']],
    [['bootstrap', '--username', '--reason', 'x']],
  ])('refuses malformed arguments %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('super-admin CLI entry point', () => {
  it('runs when started as the compiled file, in any path form, and never when merely imported', async () => {
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    const { isEntryPoint } = await import('./cli-args.js');
    const file = resolve('dist/super-admin/cli.js');
    expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true);
    expect(isEntryPoint(pathToFileURL(file).href, 'dist/super-admin/cli.js')).toBe(true);   // relative argv[1]
    expect(isEntryPoint(pathToFileURL(file).href, resolve('dist/main.js'))).toBe(false);
    expect(isEntryPoint(pathToFileURL(file).href, undefined)).toBe(false);
  });
});

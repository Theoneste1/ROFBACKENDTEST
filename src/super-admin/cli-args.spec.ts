import { parseArgs } from '../../scripts/super-admin.js';

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

/**
 * Static role-check scanner (Phase 1, P1-03 — plan v2.1 §3.4).
 *
 * Uses the TypeScript compiler API (the `typescript` dev dependency, no new
 * package) with the type checker to find every decision on the CALLER's role
 * in non-test code under src/, and fails on decisions whose default branch is
 * not a refusal — the shape that would give an unknown role (e.g. a role added
 * to the database before its access is designed) more than least privilege.
 *
 * A caller-role expression is
 *   - `.role` read on a value whose type is AuthUser or CallerCtx
 *     (src/common/auth-user.ts) — role reads on other users' records
 *     (Prisma types, Author, …) are not caller roles and are ignored; or
 *   - a call to isAdmin / isCoach / isStudent / isStaff (src/common/access/roles.ts).
 *
 * Unsafe patterns (reported unless listed in role-checks.allowlist.ts):
 *   U1  negative test (`!==`, `!=`, `!isX(…)`) in an `if` that does not refuse
 *       (its `then` branch does not end in `throw`).
 *   U2  conditional expression `test ? a : b` on a caller role: `b` is the
 *       default for every other role.
 *   U3  `if` on a caller role with an `else` that does not end in `throw`, or
 *       with no `else` and a body that neither returns nor throws
 *       (role-specific logic every other role skips).
 *   U4  dispatch fall-through: consecutive `if (role test) { … return }`
 *       statements not followed by a `throw` or a refusing guard
 *       (`if (…role…) throw …`).
 *   U5  `switch` on a caller role without a `default` that ends in `throw`.
 *   U6  a caller-role value or role-test result used outside a direct
 *       condition (stored, passed, spread, returned) — except an object-literal
 *       property `actorRole` (audit record).
 * Safe by construction: refusing guard clauses; dispatch chains ending in a
 * refusal; switch with a throwing default; `actorRole: user.role`.
 *
 * COVERAGE (deliberately limited — not a general authorization checker):
 *   catches structural default branches in caller-role decisions made through
 *   AuthUser/CallerCtx `.role` or the role helpers. It does NOT detect
 *   authorization that is not role-based (ownership, scope, status), wrong
 *   logic inside an explicit role branch, role values that reach code untyped
 *   (`any`, e.g. `req.user.role` in the unregistered StudyGroupsController), or
 *   roles read from the database. Those are covered by
 *   test/unknown-role.e2e-spec.ts, the existing role e2e suites and review.
 */
import { dirname, join, relative, resolve } from 'path';
import ts from 'typescript';

import { ROLE_CHECK_ALLOWLIST, type AllowlistEntry, type RoleRule } from './role-checks.allowlist.js';

// ── Rule engine ──────────────────────────────────────────────────────────────

interface Finding { file: string; line: number; rule: RoleRule; code: string }

interface EngineOptions {
  /** Is this the declaration of the caller identity type (AuthUser / CallerCtx)? */
  isCallerTypeDecl: (name: string, fileName: string) => boolean;
  /** Is this the declaration of a role helper? */
  isHelperDecl: (name: string, fileName: string) => boolean;
  /** Path shown in findings. */
  display: (fileName: string) => string;
}

const HELPERS = new Set(['isAdmin', 'isCoach', 'isStudent', 'isStaff', 'isHeadCoach', 'isCourseWorker', 'isCourseStaff', 'isTeacher']);
const norm = (text: string) => text.replace(/\s+/g, ' ').trim();

function scan(program: ts.Program, files: readonly ts.SourceFile[], opts: EngineOptions): Finding[] {
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  const report = (sf: ts.SourceFile, node: ts.Node, rule: RoleRule) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    findings.push({ file: opts.display(sf.fileName), line, rule, code: norm(node.getText(sf)) });
  };

  const isCallerType = (type: ts.Type): boolean => {
    if (type.isUnion() || type.isIntersection()) return type.types.some(isCallerType);
    const sym = type.aliasSymbol ?? type.getSymbol();
    return !!sym?.declarations?.some((d) => opts.isCallerTypeDecl(sym.getName(), d.getSourceFile().fileName));
  };
  const isRoleRead = (n: ts.Node): n is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(n) && n.name.text === 'role' && isCallerType(checker.getTypeAtLocation(n.expression));
  const isHelperCall = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !HELPERS.has(n.expression.text)) return false;
    let sym = checker.getSymbolAtLocation(n.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return !!sym?.declarations?.some((d) => opts.isHelperDecl(sym!.getName(), d.getSourceFile().fileName));
  };
  const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);
  const NEQ = new Set([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
  /** A role test: `role ===/!== x`, a helper call, or `!helper(…)`. Returns its polarity. */
  const roleTest = (n: ts.Node): 'positive' | 'negative' | null => {
    if (ts.isBinaryExpression(n) && (EQ.has(n.operatorToken.kind) || NEQ.has(n.operatorToken.kind))
        && (isRoleRead(n.left) || isRoleRead(n.right))) {
      return NEQ.has(n.operatorToken.kind) ? 'negative' : 'positive';
    }
    if (isHelperCall(n)) return 'positive';
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
      let inner: ts.Node = n.operand;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      const t = roleTest(inner);
      return t === 'positive' ? 'negative' : t === 'negative' ? 'positive' : null;
    }
    return null;
  };
  /** Role tests inside an expression (not descending into nested functions). */
  const testsIn = (e: ts.Node): Array<'positive' | 'negative'> => {
    const out: Array<'positive' | 'negative'> = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n)) return;
      const t = roleTest(n);
      if (t) { out.push(t); return; }
      ts.forEachChild(n, visit);
    };
    visit(e);
    return out;
  };
  const lastStatement = (s: ts.Statement): ts.Statement =>
    ts.isBlock(s) && s.statements.length ? lastStatement(s.statements[s.statements.length - 1]) : s;
  const endsIn = (s: ts.Statement | undefined, kind: ts.SyntaxKind) => !!s && lastStatement(s).kind === kind;
  const isRefusalGuard = (s: ts.Statement | undefined) =>
    !!s && ts.isIfStatement(s) && !s.elseStatement && testsIn(s.expression).length > 0 && endsIn(s.thenStatement, ts.SyntaxKind.ThrowStatement);
  const isDispatchIf = (s: ts.Statement) =>
    ts.isIfStatement(s) && !s.elseStatement && testsIn(s.expression).includes('positive')
    && endsIn(s.thenStatement, ts.SyntaxKind.ReturnStatement);

  /** Climb logical/paren/not wrappers to the node whose role decides the context. */
  const contextOf = (n: ts.Node): ts.Node => {
    let cur = n;
    for (;;) {
      const p = cur.parent;
      if (!p) return cur;
      if (ts.isParenthesizedExpression(p)) { cur = p; continue; }
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) { cur = p; continue; }
      if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { cur = p; continue; }
      return cur;
    }
  };

  for (const sf of files) {
    const reportedChains = new Set<ts.Node>();
    const visit = (n: ts.Node) => {
      // ── if statements on a caller role ──
      if (ts.isIfStatement(n)) {
        const tests = testsIn(n.expression);
        if (tests.length) {
          const refuses = endsIn(n.thenStatement, ts.SyntaxKind.ThrowStatement);
          if (!refuses) {
            if (tests.includes('negative')) report(sf, n.expression, 'U1');
            if (n.elseStatement) {
              if (!endsIn(n.elseStatement, ts.SyntaxKind.ThrowStatement) && !ts.isIfStatement(n.elseStatement)) report(sf, n.expression, 'U3');
            } else if (!endsIn(n.thenStatement, ts.SyntaxKind.ReturnStatement)) {
              report(sf, n.expression, 'U3');
            }
          }
          // U4: dispatch fall-through (checked once per chain, at its last member)
          if (isDispatchIf(n) && (ts.isBlock(n.parent) || ts.isSourceFile(n.parent))) {
            const stmts = (n.parent as ts.Block).statements;
            const i = stmts.indexOf(n);
            const next = stmts[i + 1];
            if (!(next && isDispatchIf(next)) && !reportedChains.has(n)) {
              reportedChains.add(n);
              const ok = !next || next.kind === ts.SyntaxKind.ThrowStatement || isRefusalGuard(next);
              // no next statement inside a function body means an implicit `return undefined` default
              if (!ok || !next) report(sf, n.expression, 'U4');
            }
          }
        }
      }
      // ── conditional expressions ──
      if (ts.isConditionalExpression(n) && testsIn(n.condition).length) report(sf, n, 'U2');
      // ── switch on a caller role ──
      if (ts.isSwitchStatement(n) && isRoleRead(n.expression)) {
        const def = n.caseBlock.clauses.find(ts.isDefaultClause);
        const last = def?.statements[def.statements.length - 1];
        if (!last || lastStatement(last).kind !== ts.SyntaxKind.ThrowStatement) report(sf, n.expression, 'U5');
      }
      // ── U6: role values / test results used outside a direct condition ──
      const t = roleTest(n);
      if (t) {
        const ctx = contextOf(n);
        const p = ctx.parent;
        const direct = (ts.isIfStatement(p) && p.expression === ctx)
          || (ts.isConditionalExpression(p) && p.condition === ctx);
        if (!direct && !(ts.isPrefixUnaryExpression(n.parent) && n.parent.operator === ts.SyntaxKind.ExclamationToken)) {
          report(sf, ts.isExpressionStatement(p) ? p : (p ?? ctx), 'U6');
        }
        return; // do not descend into the test itself
      } else if (isRoleRead(n)) {
        const p = n.parent;
        const inSwitch = ts.isSwitchStatement(p) && p.expression === n;
        const audit = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'actorRole';
        if (!inSwitch && !audit) report(sf, p, 'U6');
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return findings;
}

/** Findings that are not allow-listed, and allow-list entries that matched nothing. */
function applyAllowlist(findings: Finding[], allowlist: readonly AllowlistEntry[]) {
  const used = new Set<AllowlistEntry>();
  const unlisted = findings.filter((f) => {
    const entry = allowlist.find((a) => a.file === f.file && a.rule === f.rule && norm(a.code) === f.code);
    if (entry) used.add(entry);
    return !entry;
  });
  return { unlisted, stale: allowlist.filter((a) => !used.has(a)) };
}

// ── The real code ────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../../..');
const SRC = join(ROOT, 'src');

function realProgram() {
  const configPath = join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const rootNames = parsed.fileNames.filter((f) => {
    const rel = relative(SRC, f).replace(/\\/g, '/');
    return !rel.startsWith('..') && !rel.startsWith('generated/') && !rel.endsWith('.spec.ts');
  });
  const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true } });
  const files = program.getSourceFiles().filter((sf) => rootNames.some((r) => resolve(r) === resolve(sf.fileName)));
  return { program, files };
}

const toPosix = (p: string) => p.replace(/\\/g, '/');
const REAL_OPTIONS: EngineOptions = {
  isCallerTypeDecl: (name, file) => (name === 'AuthUser' || name === 'CallerCtx') && toPosix(file).endsWith('src/common/auth-user.ts'),
  isHelperDecl:     (name, file) => HELPERS.has(name) && toPosix(file).endsWith('src/common/access/roles.ts'),
  display:          (file) => toPosix(relative(ROOT, file)),
};

describe('role-check scanner — real code (src/, excluding tests and generated code)', () => {
  let findings: Finding[];
  beforeAll(() => {
    const { program, files } = realProgram();
    findings = scan(program, files.filter((sf) => !toPosix(sf.fileName).endsWith('src/common/access/roles.ts')), REAL_OPTIONS);
  }, 120_000);

  it('no caller-role decision falls through to a non-refusing default unless reviewed (allow-listed)', () => {
    const { unlisted } = applyAllowlist(findings, ROLE_CHECK_ALLOWLIST);
    expect(unlisted.map((f) => `${f.file}:${f.line} ${f.rule} ${f.code}`)).toEqual([]);
  });

  it('every allow-list entry still matches a finding (no stale entries) and has a reason', () => {
    const { stale } = applyAllowlist(findings, ROLE_CHECK_ALLOWLIST);
    expect(stale.map((a) => `${a.file} ${a.rule} ${a.code}`)).toEqual([]);
    for (const a of ROLE_CHECK_ALLOWLIST) expect([a.code, a.reason.length >= 20]).toEqual([a.code, true]);
  });

  it('actually sees caller-role decisions (sanity: the helpers are found in the service code)', () => {
    // A scanner that silently found nothing would pass the tests above.
    expect(findings.length).toBeGreaterThanOrEqual(ROLE_CHECK_ALLOWLIST.length);
    expect(ROLE_CHECK_ALLOWLIST.length).toBeGreaterThan(0);
  });
});

// ── Self-tests on in-memory sources ──────────────────────────────────────────

const VIRTUAL: Record<string, string> = {
  '/v/auth-user.ts': 'export interface AuthUser { id: string; role: string } export interface Other { id: string; role: string }',
  '/v/roles.ts': [
    "type C = { role: string };",
    "export const isAdmin = (u: C) => u.role === 'ADMIN';",
    "export const isCoach = (u: C) => u.role === 'MENTOR';",
    "export const isStudent = (u: C) => u.role === 'STUDENT';",
    'export const isStaff = (u: C) => isAdmin(u) || isCoach(u);',
  ].join('\n'),
};
const PRELUDE = "import type { AuthUser, Other } from './auth-user';\nimport { isAdmin, isCoach, isStudent, isStaff } from './roles';\n"
  + 'declare function audit(x: unknown): void;\ndeclare const data: unknown;\n';

/** Virtual paths may come back from the compiler with a drive letter on Windows (C:/v/…). */
const virtualKey = (name: string) => toPosix(name).replace(/^[A-Za-z]:/, '');

function scanSnippet(body: string): Finding[] {
  const files: Record<string, string> = { ...VIRTUAL, '/v/case.ts': PRELUDE + body };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (name, lang, ...rest) =>
    files[virtualKey(name)] !== undefined
      ? ts.createSourceFile(name, files[virtualKey(name)], lang, true)
      : original.getSourceFile(name, lang, ...rest);
  host.fileExists = (name) => files[virtualKey(name)] !== undefined || original.fileExists(name);
  host.readFile = (name) => files[virtualKey(name)] ?? original.readFile(name);
  const originalDirectoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dir) => virtualKey(dir) === '/v' || (originalDirectoryExists ? originalDirectoryExists(dir) : false);
  const program = ts.createProgram({ rootNames: Object.keys(files), options, host });
  const sf = program.getSourceFiles().find((f) => virtualKey(f.fileName) === '/v/case.ts')!;
  return scan(program, [sf], {
    isCallerTypeDecl: (name, file) => name === 'AuthUser' && virtualKey(file) === '/v/auth-user.ts',
    isHelperDecl:     (name, file) => HELPERS.has(name) && virtualKey(file) === '/v/roles.ts',
    display:          (file) => virtualKey(file),
  });
}
const rules = (body: string) => scanSnippet(body).map((f) => f.rule);

describe('role-check scanner — self-tests', () => {
  it.each([
    ['U1', "function f(user: AuthUser) { if (user.role !== 'STUDENT') { return 'staff view'; } return 'student'; }"],
    ['U1', "function f(user: AuthUser) { if (!isStudent(user)) { audit(1); } }"],
    ['U2', "function f(user: AuthUser) { return user.role === 'STUDENT' ? 'summary' : 'detail'; }"],
    ['U2', "function f(user: AuthUser) { return isStaff(user) ? 'detail' : 'summary'; }"],
    ['U3', "function f(user: AuthUser) { if (isStudent(user)) { audit(1); } else { return 'admin data'; } return 0; }"],
    ['U3', "function f(user: AuthUser, w: Record<string, unknown>) { if (isStudent(user)) { w.published = true; } return w; }"],
    ['U4', "function f(user: AuthUser) { if (isStudent(user)) { return 'a'; } if (isCoach(user)) { return 'b'; } return 'admin data'; }"],
    ['U4', "function f(user: AuthUser) { if (isAdmin(user)) return 'all'; }"],
    ['U5', "function f(user: AuthUser) { switch (user.role) { case 'ADMIN': return 1; } return 0; }"],
    ['U5', "function f(user: AuthUser) { switch (user.role) { case 'ADMIN': return 1; default: return 0; } }"],
    ['U6', "function f(user: AuthUser) { const r = user.role; return r; }"],
    ['U6', "function f(user: AuthUser) { const staff = isStaff(user); return staff; }"],
    ['U6', "function f(user: AuthUser) { return { ...(isStaff(user) && { by: 1 }) }; }"],
  ])('reports %s: %s', (rule, body) => {
    expect(rules(body)).toContain(rule);
  });

  it.each([
    "function f(user: AuthUser) { if (!isAdmin(user)) throw new Error('forbidden'); return 1; }",
    "function f(user: AuthUser, x: boolean) { if (user.role !== 'MENTOR' || x) { throw new Error('no'); } return 1; }",
    "function f(user: AuthUser) { if (isStudent(user)) { return 'a'; } if (isStaff(user)) { return 'b'; } throw new Error('unsupported'); }",
    "function f(user: AuthUser) { if (isStudent(user)) { return 'a'; } if (!isStaff(user)) throw new Error('unsupported'); return 'b'; }",
    "function f(user: AuthUser) { switch (user.role) { case 'ADMIN': return 1; default: throw new Error('404'); } }",
    "function f(user: AuthUser) { audit({ actorRole: user.role }); }",
    "function f(target: Other) { if (target.role !== 'MENTOR') { return 'not a coach'; } return target.role; }",
    "function f(user: AuthUser) { if (isStudent(user) && data) { throw new Error('404'); } return 1; }",
  ])('accepts a safe pattern: %s', (body) => {
    expect(scanSnippet(body)).toEqual([]);
  });

  it('an allow-listed finding is accepted; the same finding with changed code is reported again', () => {
    const findings = scanSnippet("function f(user: AuthUser) { return isStaff(user) ? 'detail' : 'summary'; }");
    const entry: AllowlistEntry = { file: '/v/case.ts', rule: 'U2', code: "isStaff(user) ? 'detail' : 'summary'", reason: 'default is the less-privileged summary view' };
    expect(applyAllowlist(findings, [entry]).unlisted).toEqual([]);
    const changed = scanSnippet("function f(user: AuthUser) { return isStaff(user) ? 'summary' : 'detail'; }");
    expect(applyAllowlist(changed, [entry]).unlisted.map((f) => f.rule)).toEqual(['U2']);
  });

  it('an allow-list entry that matches nothing is reported as stale', () => {
    const entry: AllowlistEntry = { file: '/v/case.ts', rule: 'U2', code: 'isAdmin(user) ? 1 : 2', reason: 'no longer present in the code at all' };
    expect(applyAllowlist([], [entry]).stale).toEqual([entry]);
  });
});

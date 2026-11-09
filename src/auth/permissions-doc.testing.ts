/**
 * Renders the six-role matrix (ROLE_GRANTS) as the Markdown table in
 * docs/PERMISSIONS.md. permissions.spec.ts checks the document still contains
 * exactly this table, so the documentation cannot drift from the code.
 */
import { APP_ROLES, PERMISSIONS, ROLE_GRANTS, ROLE_LABELS, type ScopeKind } from './permissions.js';

const SCOPE_TEXT: Record<ScopeKind, string> = {
  own:            'own',
  division:       'division',
  courseDivision: 'course × division',
  programme:      'programme',
  global:         'all',
};

export function renderPermissionMatrix(): string {
  const header = `| Permission | ${APP_ROLES.map((r) => `${ROLE_LABELS[r]} (\`${r}\`)`).join(' | ')} |`;
  const rule = `|---|${APP_ROLES.map(() => '---').join('|')}|`;
  const rows = PERMISSIONS.map((p) =>
    `| \`${p}\` | ${APP_ROLES.map((r) => { const s = ROLE_GRANTS[r][p]; return s ? SCOPE_TEXT[s] : '—'; }).join(' | ')} |`);
  return [header, rule, ...rows].join('\n');
}

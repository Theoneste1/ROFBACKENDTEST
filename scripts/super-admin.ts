/**
 * Super Admin operator commands (P1-08). CLI only; never run by a deployment.
 * Production use needs separate, recorded approval — see docs/operations/super-admin.md.
 *
 *   npx tsx scripts/super-admin.ts bootstrap --username <admin> --confirm-username <admin> --reason "<why>"
 *   npx tsx scripts/super-admin.ts break-glass reset-credentials --username <super-admin> --reason "<why>" --approval-ref <ref> [--note "<text>"]
 *   npx tsx scripts/super-admin.ts break-glass promote-admin     --username <admin>       --reason "<why>" --approval-ref <ref> [--note "<text>"]
 *
 * Exit codes: 0 done · 2 usage error · 3 refused (nothing changed).
 * Uses DATABASE_URL like the application; prints no connection details.
 */
import 'dotenv/config';
import 'reflect-metadata';

export function parseArgs(argv: string[]) {
  const [command, maybeMode, ...rest] = argv;
  const flags: Record<string, string> = {};
  const list = command === 'break-glass' ? rest : [maybeMode, ...rest].filter((x) => x !== undefined);
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (!k?.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
    const v = list[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${k}`);
    flags[k.slice(2)] = v; i++;
  }
  return { command, mode: command === 'break-glass' ? maybeMode : undefined, flags };
}

async function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!['bootstrap', 'break-glass'].includes(args.command ?? '')) throw new Error('command must be bootstrap or break-glass');
    if (args.command === 'break-glass' && !['reset-credentials', 'promote-admin'].includes(args.mode ?? '')) {
      throw new Error('break-glass mode must be reset-credentials or promote-admin');
    }
  } catch (err) {
    console.error(`Usage error: ${(err as Error).message}. See the header of scripts/super-admin.ts.`);
    process.exit(2);
  }

  process.env.WORKERS_ENABLED = 'false';   // no background jobs in a one-off command
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app/app.module.js');
  const { SuperAdminModule } = await import('../src/super-admin/super-admin.module.js');
  const { SuperAdminOperationsService } = await import('../src/super-admin/super-admin-operations.service.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const ops = app.select(SuperAdminModule).get(SuperAdminOperationsService);
    const f = args.flags;
    if (args.command === 'bootstrap') {
      const r = await ops.bootstrap({ username: f.username, confirmUsername: f['confirm-username'], reason: f.reason });
      console.log(`Done: "${f.username}" is now the Super Administrator (user ${r.userId}). Sessions ended; audit row written.`);
    } else {
      const r = await ops.breakGlass({ mode: args.mode as never, username: f.username, reason: f.reason, approvalRef: f['approval-ref'], operatorNote: f.note });
      console.log(`Done: break-glass ${args.mode} for "${f.username}" (user ${r.userId}). Sessions ended; audit row written.`);
      if (r.temporaryPassword) console.log(`One-time password (shown once; hand over securely, change at first login): ${r.temporaryPassword}`);
    }
  } catch (err) {
    console.error(`Refused: ${(err as { code?: string }).code ?? 'ERROR'} — ${(err as Error).message} Nothing was changed.`);
    process.exitCode = 3;
  } finally {
    await app.close();
  }
}

if (process.argv[1] && /super-admin\.ts$/.test(process.argv[1])) void main();

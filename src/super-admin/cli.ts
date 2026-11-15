/**
 * Super Admin operator commands (P1-08). CLI only; never run by a deployment.
 * Production use needs separate, recorded approval — see docs/operations/super-admin.md.
 *
 * Built with the application (`npm run build`) and run with Node — in a checkout or inside the
 * runtime image, where it is dist/super-admin/cli.js:
 *
 *   node dist/super-admin/cli.js bootstrap --username <admin> --dry-run
 *   node dist/super-admin/cli.js bootstrap --username <admin> --confirm-username <admin> --reason "<why>"
 *   node dist/super-admin/cli.js break-glass reset-credentials --username <super-admin> --reason "<why>" --approval-ref <ref> [--note "<text>"]
 *   node dist/super-admin/cli.js break-glass promote-admin     --username <admin>       --reason "<why>" --approval-ref <ref> [--note "<text>"]
 *   (npm run super-admin -- <same arguments>)
 *
 * It must be COMPILED: it boots the Nest application, whose dependency injection needs the
 * decorator metadata that tsc emits and tsx/esbuild do not (run through tsx, the injected services
 * are undefined and the command crashes before doing anything).
 *
 * --dry-run (bootstrap only) prints the target's username, name, role, active and activated status,
 * the number of active Super Admins and the refusal the bootstrap would give — and changes nothing.
 * The seeded shared account (`admin` / SEED_ADMIN_USERNAME) is always refused (SHARED_ACCOUNT_REFUSED).
 *
 * Exit codes: 0 done (dry run: the bootstrap would go ahead) · 2 usage error · 3 refused (nothing changed;
 * dry run: the bootstrap would be refused).
 * Uses DATABASE_URL like the application; prints no connection details.
 */
import 'dotenv/config';
import 'reflect-metadata';
import { isEntryPoint, parseArgs } from './cli-args.js';
async function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!['bootstrap', 'break-glass'].includes(args.command ?? '')) throw new Error('command must be bootstrap or break-glass');
    if (args.command === 'break-glass' && !['reset-credentials', 'promote-admin'].includes(args.mode ?? '')) {
      throw new Error('break-glass mode must be reset-credentials or promote-admin');
    }
  } catch (err) {
    console.error(`Usage error: ${(err as Error).message}. See the header of src/super-admin/cli.ts.`);
    process.exit(2);
  }

  process.env.WORKERS_ENABLED = 'false';   // no background jobs in a one-off command
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app/app.module.js');
  const { SuperAdminModule } = await import('./super-admin.module.js');
  const { SuperAdminOperationsService } = await import('./super-admin-operations.service.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const ops = app.select(SuperAdminModule).get(SuperAdminOperationsService);
    const f = args.flags;
    if (args.command === 'bootstrap' && f['dry-run']) {
      const v = await ops.bootstrapPreview(f.username ?? '');
      const yesNo = (b: boolean | null) => (b === null ? '—' : b ? 'yes' : 'no');
      console.log('DRY RUN — nothing is changed.');
      console.log(`  Username:            ${v.username || '—'}${v.found ? '' : ' (no such account)'}`);
      console.log(`  Name:                ${v.name ?? '—'}`);
      console.log(`  Current role:        ${v.role ?? '—'}`);
      console.log(`  Active:              ${yesNo(v.isActive)}`);
      console.log(`  Activated:           ${yesNo(v.activated)}`);
      console.log(`  Active Super Admins: ${v.activeSuperAdmins}`);
      console.log(v.wouldRefuse ? `  Bootstrap would be REFUSED: ${v.wouldRefuse}` : '  Bootstrap would go ahead.');
      if (v.wouldRefuse) process.exitCode = 3;
    } else if (args.command === 'bootstrap') {
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

if (isEntryPoint(import.meta.url, process.argv[1])) void main();

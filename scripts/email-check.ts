/**
 * Check the Resend set-up and optionally send a real test e-mail.
 *
 *   npm run email:check                      # API key + domain verification status
 *   npm run email:check -- you@example.org   # … and send a branded test e-mail
 *
 * Reads RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO and APP_URL from the
 * environment / .env. Never prints the API key.
 */
import 'dotenv/config';
import { Resend } from 'resend';

import { addressOf, DEFAULT_FROM } from '../src/email/mailer.service.js';
import { ORGANIZATION, renderEmail } from '../src/email/templates.js';

async function main() {
  const key     = process.env.RESEND_API_KEY;
  const from    = process.env.EMAIL_FROM || DEFAULT_FROM;
  const replyTo = process.env.EMAIL_REPLY_TO || addressOf(from);
  const appUrl  = process.env.APP_URL ?? null;
  const to      = process.argv[2];

  if (!key) {
    fail('RESEND_API_KEY is not set. Add it to .env (never commit it) — see docs/EMAIL.md §2.');
  }
  console.log(`API key:  set (${key.slice(0, 3)}…, ${key.length} characters)`);
  console.log(`Sender:   ${from}`);
  console.log(`Reply-to: ${replyTo}`);
  console.log(`APP_URL:  ${appUrl ?? '(not set — e-mails will have no buttons)'}`);

  const resend = new Resend(key);
  const domain = addressOf(from).split('@')[1]?.toLowerCase();

  // ── Domain status (needs a "Full access" key; a "Sending access" key cannot list domains) ──
  const list = await resend.domains.list();
  if (list.error) {
    if (list.error.name === 'invalid_api_key') fail('Resend rejected the API key (invalid_api_key). Create a new key in the Resend dashboard.');
    console.log(`\nDomain status: not available with this key (${list.error.name}). That is normal for a "Sending access" key.`);
  } else {
    const found = list.data?.data.find((d) => d.name.toLowerCase() === domain);
    if (!found) {
      console.log(`\nDomain ${domain} is NOT added in this Resend account. Add it under Domains → Add domain (docs/EMAIL.md §3).`);
    } else {
      const details = await resend.domains.get(found.id);
      console.log(`\nDomain ${found.name}: ${found.status.toUpperCase()} (region ${found.region})`);
      for (const r of details.data?.records ?? []) {
        console.log(`  ${r.status.padEnd(12)} ${r.record.padEnd(6)} ${r.type.padEnd(5)} ${r.name}`);
      }
      if (found.status !== 'verified') {
        console.log('  → Add the records above at your DNS provider exactly as shown in the Resend dashboard, then click "Verify".');
      }
    }
  }

  if (!to) {
    console.log('\nNo recipient given: nothing sent. Run `npm run email:check -- you@example.org` to send a test e-mail.');
    return;
  }

  const mail = renderEmail({
    heading:  'Test e-mail',
    body:     `This is a test e-mail from the ${ORGANIZATION} learning platform.\n\nIf you can read this, e-mail delivery through Resend works.`,
    action:   appUrl ? { label: 'Open the platform', url: appUrl } : undefined,
    note:     `Sent ${new Date().toISOString()} by scripts/email-check.ts.`,
  }, { organization: ORGANIZATION, contactEmail: replyTo, appUrl });

  const { data, error } = await resend.emails.send({
    from, to, replyTo, subject: `[${ORGANIZATION}] Test e-mail`, text: mail.text, html: mail.html,
  });
  if (error) fail(`Resend refused the e-mail: ${error.statusCode ?? ''} ${error.name}: ${error.message}`);
  console.log(`\nAccepted by Resend, id ${data!.id}. Check the inbox (and spam folder) of ${to},`);
  console.log('and the e-mail\'s status under Emails in the Resend dashboard ("Delivered" means the receiving server accepted it).');
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

main().catch((err) => fail((err as Error).message));

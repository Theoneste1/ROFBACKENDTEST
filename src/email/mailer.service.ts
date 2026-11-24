/**
 * MailerService — sends one e-mail through Resend (https://resend.com).
 *
 * Configuration (environment, see docs/EMAIL.md):
 *   RESEND_API_KEY       – API key. Missing → DRY RUN: e-mails are logged, never
 *                          sent (refused in production by env validation).
 *   EMAIL_FROM           – "Name <address>" on a domain verified in Resend.
 *   EMAIL_REPLY_TO       – Reply-to address (default: the EMAIL_FROM address).
 *   EMAIL_REDIRECT_TO    – Testing safeguard: every e-mail goes to this address
 *                          instead of the real recipient.
 *   EMAIL_DRY_RUN=true   – STAGING ONLY: nothing is sent even with a key (logged,
 *                          warned at every start); allowed with NODE_ENV=production.
 *   EMAIL_MAX_PER_SECOND – Sending rate (default 2, Resend's default limit).
 *   EMAIL_BATCH_SIZE     – Deliveries the worker claims per batch (default 50).
 *
 * Provider limits: a 429 answer (rate limit, daily or monthly quota) is reported
 * as deferMs + limit, not as a failure — the senders re-queue the e-mail without
 * spending an attempt and pause every sender (EmailBudgetService.pauseForProvider:
 * a daily quota until just after 00:00 UTC, when Resend resets it;
 * a monthly quota 12–24 hours; the per-second limit RATE_PAUSE_MS). The platform's
 * own budget (EMAIL_DAILY_LIMIT / EMAIL_MONTHLY_LIMIT, docs/EMAIL.md §10) normally
 * keeps it from ever reaching a quota.
 *
 * Never logs message bodies (they can carry one-time links); recipients are
 * masked in logs.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export const DEFAULT_FROM = 'Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>';

export interface OutgoingEmail {
  to:       string;
  subject:  string;
  text:     string;
  html?:    string | null;
  /** Same key → Resend sends at most once (24 h). Use the delivery id. */
  idempotencyKey?: string;
  /** Extra headers, e.g. List-Unsubscribe on e-mails to news subscribers. */
  headers?: Record<string, string>;
}

export interface SendResult {
  /** Resend e-mail id on success. */
  messageId: string | null;
  accepted:  boolean;
  error:     string | null;
  /** The request itself is wrong (bad address…): retrying cannot help. */
  permanent: boolean;
  /** The provider refused for a limit (429): send again after this many ms; not a failed attempt. */
  deferMs?:  number;
  /** Which provider limit answered (with deferMs). */
  limit?:    ProviderLimit;
}

/** A provider limit answer (429): the daily or monthly quota, or the per-second rate limit. */
export type ProviderLimit = 'DAILY_QUOTA' | 'MONTHLY_QUOTA' | 'RATE_LIMIT';

/** Pause after a daily or monthly quota answer. */
export const QUOTA_PAUSE_MS = 60 * 60_000;
/** Pause after a per-second rate-limit answer. */
export const RATE_PAUSE_MS  = 60_000;
const QUOTA_ERRORS = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);

/** Resend errors caused by the message itself, not by the configuration or the service. */
const PERMANENT_ERRORS = new Set(['validation_error', 'invalid_parameter', 'missing_required_field', 'invalid_idempotent_request']);

@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private client: Resend | null = null;
  private nextSlot = 0;

  readonly from:       string;
  readonly replyTo:    string | undefined;
  readonly redirectTo: string | undefined;
  private readonly intervalMs: number;

  constructor(private readonly config: ConfigService) {
    this.from       = config.get<string>('EMAIL_FROM') || DEFAULT_FROM;
    this.replyTo    = config.get<string>('EMAIL_REPLY_TO') || addressOf(this.from);
    this.redirectTo = config.get<string>('EMAIL_REDIRECT_TO') || undefined;
    const perSecond = Number(config.get('EMAIL_MAX_PER_SECOND') ?? 2) || 2;
    this.intervalMs = Math.ceil(1000 / Math.max(perSecond, 1));
  }

  onModuleInit() {
    const key = this.config.get<string>('RESEND_API_KEY');
    if (String(this.config.get('EMAIL_DRY_RUN') ?? '').toLowerCase() === 'true') {
      this.logger.warn('EMAIL_DRY_RUN=true: NO e-mail is sent (staging). Messages are logged only. Never set this in production.');
      return;
    }
    if (!key) {
      this.logger.warn(
        'RESEND_API_KEY is not set: e-mail is in DRY RUN mode — messages are logged, not sent. ' +
        'Set RESEND_API_KEY to deliver e-mail (see docs/EMAIL.md).',
      );
      return;
    }
    // Tests may only talk to a fake Resend API, never the real one.
    if (this.config.get<string>('NODE_ENV') === 'test' && !process.env.RESEND_BASE_URL) {
      this.logger.warn('NODE_ENV=test without RESEND_BASE_URL: e-mail stays in DRY RUN mode.');
      return;
    }
    this.client = new Resend(key);
    this.logger.log(`E-mail delivery via Resend, from ${this.from}`);
    if (this.redirectTo) {
      this.logger.warn(`EMAIL_REDIRECT_TO is set: every e-mail is delivered to ${this.redirectTo} instead of its recipient.`);
    }
  }

  /** Whether e-mails are only logged. */
  get isDryRun(): boolean {
    return this.client === null;
  }

  /** Batch size from config (default 50, minimum 1, maximum 500). */
  get batchSize(): number {
    const raw = parseInt(this.config.get<string>('EMAIL_BATCH_SIZE') ?? '50', 10);
    return Math.min(Math.max(isNaN(raw) ? 50 : raw, 1), 500);
  }

  /** Send one e-mail. Never throws: failures are returned for the caller to record. */
  async sendOne(mail: OutgoingEmail): Promise<SendResult> {
    const to      = this.redirectTo ?? mail.to;
    const subject = this.redirectTo ? `[to ${mail.to}] ${mail.subject}` : mail.subject;

    if (!this.client) {
      this.logger.log(`[DRY RUN] "${mail.subject}" → ${maskEmail(mail.to)}`);
      return { messageId: `dry-run-${Date.now()}`, accepted: true, error: null, permanent: false };
    }

    await this.throttle();
    try {
      const { data, error } = await this.client.emails.send(
        {
          from:    this.from,
          to,
          subject: subject.slice(0, 998),
          text:    mail.text,
          ...(mail.html && { html: mail.html }),
          ...(this.replyTo && { replyTo: this.replyTo }),
          ...(mail.headers && Object.keys(mail.headers).length > 0 && { headers: mail.headers }),
        },
        mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : {},
      );

      if (error || !data) {
        const permanent = !!error && PERMANENT_ERRORS.has(error.name) && error.statusCode !== 403;
        const message   = error ? `Resend ${error.statusCode ?? 'network'} ${error.name}: ${error.message}` : 'Resend returned no data.';
        if (error && (error.statusCode === 429 || QUOTA_ERRORS.has(error.name))) {
          const deferMs = QUOTA_ERRORS.has(error.name) ? QUOTA_PAUSE_MS : RATE_PAUSE_MS;
          const limit: ProviderLimit = error.name === 'monthly_quota_exceeded' ? 'MONTHLY_QUOTA' : error.name === 'daily_quota_exceeded' ? 'DAILY_QUOTA' : 'RATE_LIMIT';
          this.logger.warn(`E-mail to ${maskEmail(to)} deferred by a provider limit (${error.name}); sending pauses.`);
          return { messageId: null, accepted: false, error: message, permanent: false, deferMs, limit };
        }
        this.logger.error(`E-mail to ${maskEmail(to)} failed (${permanent ? 'permanent' : 'will retry'}): ${message}`);
        return { messageId: null, accepted: false, error: message, permanent };
      }

      this.logger.log(`E-mail "${mail.subject}" → ${maskEmail(to)} accepted by Resend (id ${data.id})`);
      return { messageId: data.id, accepted: true, error: null, permanent: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`E-mail to ${maskEmail(to)} failed (will retry): ${message}`);
      return { messageId: null, accepted: false, error: message, permanent: false };
    }
  }

  /** Space requests out to stay under Resend's per-second rate limit. */
  private async throttle() {
    const now  = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** "Name <a@b.org>" → "a@b.org" */
export function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();
}

/** "jean.uwase@example.com" → "j***e@example.com" (logs only). */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const shown = local.length <= 2 ? local[0] : `${local[0]}***${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

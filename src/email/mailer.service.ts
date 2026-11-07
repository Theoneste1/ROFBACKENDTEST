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
 *   EMAIL_MAX_PER_SECOND – Sending rate (default 2, Resend's default limit).
 *   EMAIL_BATCH_SIZE     – Deliveries the worker claims per batch (default 50).
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
}

export interface SendResult {
  /** Resend e-mail id on success. */
  messageId: string | null;
  accepted:  boolean;
  error:     string | null;
  /** The request itself is wrong (bad address…): retrying cannot help. */
  permanent: boolean;
}

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
    if (!key) {
      this.logger.warn(
        'RESEND_API_KEY is not set: e-mail is in DRY RUN mode — messages are logged, not sent. ' +
        'Set RESEND_API_KEY to deliver e-mail (see docs/EMAIL.md).',
      );
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
        },
        mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : {},
      );

      if (error || !data) {
        const permanent = !!error && PERMANENT_ERRORS.has(error.name) && error.statusCode !== 403;
        const message   = error ? `Resend ${error.statusCode ?? 'network'} ${error.name}: ${error.message}` : 'Resend returned no data.';
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

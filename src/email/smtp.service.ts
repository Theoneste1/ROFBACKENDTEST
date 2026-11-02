/**
 * SmtpService
 *
 * Thin wrapper around Nodemailer. The service reads credentials from
 * environment variables at startup. If SMTP_HOST is not configured it
 * operates in DRY_RUN mode: messages are logged to the console but no
 * actual network connection is made.
 *
 * PROVIDER SETUP (set in .env):
 *   SMTP_HOST       – Hostname of your SMTP relay (e.g. smtp.sendgrid.net)
 *   SMTP_PORT       – Usually 587 (STARTTLS) or 465 (SSL). Default: 587.
 *   SMTP_SECURE     – true for port 465, false for 587 STARTTLS. Default: false.
 *   SMTP_USER       – SMTP login username (or "apikey" for SendGrid).
 *   SMTP_PASS       – SMTP password or API key.
 *   EMAIL_FROM      – From address shown to recipients. Default: noreply@rof.local
 *   EMAIL_BATCH_SIZE – Recipients processed per batch in the background. Default: 50.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface SendResult {
  /** Nodemailer message ID on success. */
  messageId: string | null;
  accepted:  boolean;
  error:     string | null;
}

@Injectable()
export class SmtpService implements OnModuleInit {
  private readonly logger = new Logger(SmtpService.name);

  private transporter: Transporter | null = null;
  private dryRun = false;
  readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = config.get<string>('EMAIL_FROM') ?? 'noreply@rof.local';
  }

  onModuleInit() {
    const host = this.config.get<string>('SMTP_HOST');

    if (!host) {
      this.dryRun = true;
      this.logger.warn(
        'SMTP_HOST is not configured. Email module is running in DRY_RUN mode. ' +
        'No emails will be sent. Set SMTP_HOST in .env to enable delivery.',
      );
      return;
    }

    const port   = parseInt(this.config.get<string>('SMTP_PORT') ?? '587', 10);
    const secure = (this.config.get<string>('SMTP_SECURE') ?? 'false') === 'true';
    const user   = this.config.get<string>('SMTP_USER');
    const pass   = this.config.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      // Reuse connections across the worker's concurrent sends.
      pool:           true,
      maxConnections: 5,
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    this.logger.log(`SMTP transport initialised → ${host}:${port} (secure=${secure})`);
  }

  /** Whether the service is operating without a real SMTP connection. */
  get isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * Send a single email. Returns a `SendResult` — never throws.
   * All errors are caught and returned in the result object so the
   * caller can persist failure details without crashing the batch.
   */
  async sendOne(to: string, subject: string, text: string): Promise<SendResult> {
    if (this.dryRun) {
      this.logger.debug(`[DRY_RUN] Would send "${subject}" → ${to}`);
      return { messageId: `dry-run-${Date.now()}`, accepted: true, error: null };
    }

    try {
      const info = await this.transporter!.sendMail({
        from:    this.from,
        to,
        subject,
        text,
      });
      return { messageId: info.messageId ?? null, accepted: true, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { messageId: null, accepted: false, error: message };
    }
  }

  /** Batch size from config (default 50, minimum 1, maximum 500). */
  get batchSize(): number {
    const raw = parseInt(this.config.get<string>('EMAIL_BATCH_SIZE') ?? '50', 10);
    return Math.min(Math.max(isNaN(raw) ? 50 : raw, 1), 500);
  }
}

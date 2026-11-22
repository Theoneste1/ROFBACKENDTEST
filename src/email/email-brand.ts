import type { ConfigService } from '@nestjs/config';

import type { SettingsService } from '../settings/settings.service.js';
import { addressOf, DEFAULT_FROM } from './mailer.service.js';
import { ORGANIZATION, type EmailBrand } from './templates.js';

/** The official address of the platform (the website people know). */
export const OFFICIAL_SITE_URL = 'https://lms.rwandaolympiadfoundation.org';
/**
 * Hosting addresses that must never appear in an e-mail (owner 2026-11-22: "remove the netlify links"): links, the logo
 * and the footer use the official address instead. Staging keeps its own address (it is not listed here).
 */
const HOSTING_ALIASES: readonly string[] = ['roflms.netlify.app'];

/** APP_URL as e-mails show it: the production hosting address is replaced by the official one. */
export function emailSiteUrl(appUrl: string | null | undefined): string | null {
  const raw = appUrl?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (HOSTING_ALIASES.includes(u.hostname.toLowerCase())) return OFFICIAL_SITE_URL;
  } catch {
    return raw;
  }
  return raw;
}

/**
 * Branding for e-mail templates. The footer contact is the support address
 * from the platform settings, else EMAIL_REPLY_TO, else the sender address.
 */
export async function loadEmailBrand(settings: SettingsService, config: ConfigService): Promise<EmailBrand> {
  const support = await settings.get('platform.supportEmail');
  const contact = support || config.get<string>('EMAIL_REPLY_TO') || addressOf(config.get<string>('EMAIL_FROM') || DEFAULT_FROM);
  return {
    organization: ORGANIZATION,
    contactEmail: contact || null,
    appUrl:       emailSiteUrl(config.get<string>('APP_URL')),
  };
}

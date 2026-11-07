import type { ConfigService } from '@nestjs/config';

import type { SettingsService } from '../settings/settings.service.js';
import { addressOf, DEFAULT_FROM } from './mailer.service.js';
import { ORGANIZATION, type EmailBrand } from './templates.js';

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
    appUrl:       config.get<string>('APP_URL') ?? null,
  };
}

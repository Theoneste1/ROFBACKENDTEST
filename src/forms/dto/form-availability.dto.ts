import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

import type { FormMode } from '../../generated/prisma/client.js';
import { FORM_MODES } from '../form-availability.rules.js';

/**
 * PATCH /admin/forms/:key/availability (forms.manageAvailability). Partial: an omitted field is unchanged; null
 * removes a date. Times are ISO 8601 instants with a time zone (e.g. "2026-12-01T06:00:00Z" or
 * "2026-12-01T08:00:00+02:00" for 08:00 in Kigali).
 */
export class UpdateFormAvailabilityDto {
  /** OPEN (open now, until closesAt if set), CLOSED, or SCHEDULED (open from opensAt until closesAt). */
  @IsOptional()
  @IsIn(FORM_MODES, { message: 'mode must be OPEN, CLOSED or SCHEDULED.' })
  mode?: FormMode;

  /** When a SCHEDULED form opens (required for SCHEDULED). null removes it. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'opensAt must be an ISO 8601 date and time, e.g. 2026-12-01T08:00:00+02:00.' })
  opensAt?: string | null;

  /** When the form closes (OPEN or SCHEDULED); null = no closing date. Must be after opensAt. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'closesAt must be an ISO 8601 date and time, e.g. 2026-12-31T17:00:00+02:00.' })
  closesAt?: string | null;
}

/**
 * PATCH /admin/forms/:key/messages (forms.editMessages). Partial: an omitted field is unchanged; null (or an empty
 * text) restores the built-in closed message, or removes the instructions, e-mail or link.
 */
export class UpdateFormMessagesDto {
  /** Shown while the form is closed (and returned with a refused submission). */
  @IsOptional() @IsString() @MaxLength(1000)
  closedMessage?: string | null;

  /** Extra guidance shown with the form (open or closed). */
  @IsOptional() @IsString() @MaxLength(2000)
  instructions?: string | null;

  @IsOptional()
  @IsEmail({}, { message: 'contactEmail must be an e-mail address.' })
  @MaxLength(254)
  contactEmail?: string | null;

  /** A support page; https only. */
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'supportUrl must be an https:// link.' })
  @MaxLength(500)
  supportUrl?: string | null;
}

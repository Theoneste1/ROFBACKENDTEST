import { Body, Controller, Get, HttpStatus, Injectable, Param, Patch, PipeTransform, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import type { FormKey } from '../generated/prisma/client.js';
import { UpdateFormAvailabilityDto, UpdateFormMessagesDto } from './dto/form-availability.dto.js';
import { FormAvailabilityService, isFormKey } from './form-availability.service.js';

/** STUDENT_REGISTRATION, TEACHER_REGISTRATION, COACH_APPLICATION or CONTACT; anything else is 404 FORM_NOT_FOUND. */
@Injectable()
export class FormKeyPipe implements PipeTransform<string, FormKey> {
  transform(value: string): FormKey {
    if (!isFormKey(value)) throw new AppError(HttpStatus.NOT_FOUND, 'FORM_NOT_FOUND', 'This form does not exist. Go back to the Forms page and choose a form from the list.');
    return value;
  }
}

const requestId = (req: Request) => ((req as Request & { id?: string }).id ?? null);

/**
 * Whether each registration and website form is open, for everyone (no sign-in): the website and the sign-up
 * pages show the form, or its closed message, from this. Submissions are refused by the backend while closed.
 */
@ApiTags('Forms')
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormAvailabilityService) {}

  /** Every form: { key, label, open, state, opensAt, closesAt, closedMessage, instructions, contactEmail, supportUrl, timezone, serverTime }. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get()
  list() {
    return this.forms.publicList();
  }

  /** One form (404 FORM_NOT_FOUND for an unknown key). */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(':key')
  one(@Param('key', FormKeyPipe) key: FormKey) {
    return this.forms.publicView(key);
  }
}

/**
 * Administrators manage the forms: forms.view (read), forms.manageAvailability (open, close, schedule),
 * forms.editMessages (closed message, instructions, contact e-mail, support link). Every change is audited.
 */
@ApiTags('Admin · Forms')
@Controller('admin/forms')
export class AdminFormsController {
  constructor(private readonly forms: FormAvailabilityService) {}

  /** Every form with its mode, schedule, messages, computed state and who changed it last. */
  @Get()
  @RequirePermission('forms.view')
  list() {
    return this.forms.adminList();
  }

  @Get(':key')
  @RequirePermission('forms.view')
  one(@Param('key', FormKeyPipe) key: FormKey) {
    return this.forms.adminView(key);
  }

  /** The form's changes, newest first (audit rows; `limit` 1–200, default 50). */
  @Get(':key/history')
  @RequirePermission('forms.view')
  history(@Param('key', FormKeyPipe) key: FormKey, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.forms.history(key, Number.isInteger(n) ? n : 50);
  }

  /** Open, close or schedule the form. 400 INVALID_FORM_SCHEDULE (SCHEDULED needs opensAt; closesAt after opensAt). */
  @Patch(':key/availability')
  @RequirePermission('forms.manageAvailability')
  availability(@Param('key', FormKeyPipe) key: FormKey, @Body() body: UpdateFormAvailabilityDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.forms.updateAvailability(key, body, user, requestId(req));
  }

  /** Closed message, instructions, contact e-mail and support link (null or "" restores the default / removes). */
  @Patch(':key/messages')
  @RequirePermission('forms.editMessages')
  messages(@Param('key', FormKeyPipe) key: FormKey, @Body() body: UpdateFormMessagesDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.forms.updateMessages(key, body, user, requestId(req));
  }
}

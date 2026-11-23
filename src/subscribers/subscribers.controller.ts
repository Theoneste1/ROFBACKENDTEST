import {
  Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { Public } from '../common/decorators/public.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { sendCsvExport } from '../reports/csv-stream.js';
import { IMPORT_MAX_BYTES } from './subscriber-rules.js';
import { SubscribersService } from './subscribers.service.js';
import { MailingsService } from './mailings.service.js';
import {
  CreateMailingDto, CreateSubscriberDto, ExportSubscribersDto, ImportSubscribersQueryDto, ListMailingsDto, ListSubscribersDto,
  MailingAudienceDto, OneClickUnsubscribeQueryDto, SubscribeDto, TestMailingDto, UnsubscribeDto, UpdateSubscriberDto,
} from './subscribers.dto.js';

/** The public half: subscribe and unsubscribe. No authentication; rate-limited per IP. */
@ApiTags('Public site')
@Controller('public')
export class PublicSubscribersController {
  constructor(private readonly service: SubscribersService) {}

  /**
   * Subscribe to ROF news. Always the same 202 answer — new address, already subscribed or unsubscribed before (which
   * subscribes it again) — so the answer never tells whether an address is on the list. At most 10 per hour per IP.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  @Post('subscribe')
  @HttpCode(202)
  subscribe(@Body() body: SubscribeDto) {
    return this.service.subscribe(body);
  }

  /** The unsubscribe page's button: `id` and `token` from the link in every e-mail. Idempotent. Invalid link → 400. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  @Post('unsubscribe')
  @HttpCode(200)
  unsubscribe(@Body() body: UnsubscribeDto) {
    return this.service.unsubscribe(body.id, body.token, body.reason, 'PAGE');
  }

  /**
   * RFC 8058 one-click unsubscribe (List-Unsubscribe-Post): mail clients POST "List-Unsubscribe=One-Click" to the URL in
   * the List-Unsubscribe header. The subscriber and token are in the query string; the body is not read.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  @Post('unsubscribe/one-click')
  @HttpCode(200)
  oneClick(@Query() q: OneClickUnsubscribeQueryDto) {
    return this.service.unsubscribe(q.s, q.t, undefined, 'ONE_CLICK');
  }
}

/** The news list, for Administrators and Super Admins (subscribers.manage). Every change is audited. */
@ApiTags('Admin · Subscribers')
@ApiBearerAuth()
@Controller('admin/subscribers')
export class AdminSubscribersController {
  constructor(
    private readonly service: SubscribersService,
    private readonly mailings: MailingsService,
  ) {}

  /** Subscribers: q (e-mail or name), status, interest, kind, source, country; sort newest | oldest | name | email. */
  @Get()
  @RequirePermission('subscribers.manage')
  list(@Query() q: ListSubscribersDto) {
    return this.service.list(q);
  }

  /** Active and unsubscribed counts; active subscribers by source, kind and interest. */
  @Get('summary')
  @RequirePermission('subscribers.manage')
  summary() {
    return this.service.summary();
  }

  /** The filtered list as CSV (every row; streamed). Audited. */
  @Get('export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('subscribers.manage')
  async export(@Query() q: ExportSubscribersDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const csv = await this.service.exportCsv(q, user);
    await sendCsvExport(res, `subscribers-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  /** Add one person (source ADMIN). 409 when the address is already listed (or unsubscribed). */
  @Post()
  @RequirePermission('subscribers.manage')
  create(@Body() body: CreateSubscriberDto, @CurrentUser() user: AuthUser) {
    return this.service.create(body, user);
  }

  /**
   * Import a CSV (at most 1 MB / 5,000 rows): email, name, kind, interests, country. New valid addresses are added;
   * listed ones are left alone; people who unsubscribed are never added again; problems are reported per line.
   * dryRun=true checks only (200); an import answers 201.
   */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  @RequirePermission('subscribers.manage')
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() q: ImportSubscribersQueryDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.importCsv(file, q, user);
    res.status(result.dryRun ? 200 : 201);
    return result;
  }

  // ─── Mailings (declared before :id) ─────────────────────────────────────────

  /** Earlier mailings, newest first, with their delivery counts. */
  @Get('mailings')
  @RequirePermission('subscribers.manage')
  listMailings(@Query() q: ListMailingsDto) {
    return this.mailings.list(q);
  }

  /** How many active subscribers an audience reaches. */
  @Post('mailings/preview')
  @HttpCode(200)
  @RequirePermission('subscribers.manage')
  preview(@Body() body: MailingAudienceDto) {
    return this.mailings.preview(body);
  }

  /** Send the e-mail to yourself only, as subscribers will see it. */
  @Post('mailings/test')
  @HttpCode(202)
  @RequirePermission('subscribers.manage')
  sendTest(@Body() body: TestMailingDto, @CurrentUser() user: AuthUser) {
    return this.mailings.sendTest(body, user);
  }

  /** Queue a mailing to the ACTIVE subscribers of the audience (sent after a short delay, during which it can be cancelled). */
  @Post('mailings')
  @RequirePermission('subscribers.manage')
  createMailing(@Body() body: CreateMailingDto, @CurrentUser() user: AuthUser) {
    return this.mailings.create(body, user);
  }

  @Get('mailings/:id')
  @RequirePermission('subscribers.manage')
  mailing(@Param('id', ParseUUIDPipe) id: string) {
    return this.mailings.get(id);
  }

  /** Withdraw what has not been sent yet. 409 once the mailing is sent or cancelled. */
  @Post('mailings/:id/cancel')
  @HttpCode(200)
  @RequirePermission('subscribers.manage')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.mailings.cancel(id, user);
  }

  /** Change name, kind, interests, country; unsubscribe (reason optional) or subscribe again (reason required). */
  @Patch(':id')
  @RequirePermission('subscribers.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSubscriberDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, body, user);
  }

  /** Erase a subscriber (a privacy request); their e-mails not yet sent are withdrawn. */
  @Delete(':id')
  @RequirePermission('subscribers.manage')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }
}

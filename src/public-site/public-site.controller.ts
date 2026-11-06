import { Body, Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';

import { PublicSiteService } from './public-site.service.js';
import { CreateContactMessageDto, ListContactMessagesDto, UpdateContactMessageDto } from './dto/contact.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

/** Data for the public homepage. No authentication. */
@ApiTags('Public site')
@Controller('public')
export class PublicSiteController {
  constructor(private readonly service: PublicSiteService) {}

  /** Aggregate community counts (no personal data). Cached for 5 minutes. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('statistics')
  statistics() {
    return this.service.statistics();
  }

  /** Contact form. At most 5 per hour per IP (plus per-e-mail and duplicate limits). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @Post('contact')
  @HttpCode(201)
  contact(@Body() body: CreateContactMessageDto, @Ip() ip: string) {
    return this.service.contact(body, ip);
  }
}

/** Contact-form messages, for administrators. */
@ApiTags('Admin · Contact messages')
@Controller('admin/contact-messages')
@Roles('ADMIN')
export class ContactMessagesController {
  constructor(private readonly service: PublicSiteService) {}

  @Get()
  list(@Query() query: ListContactMessagesDto) {
    return this.service.listMessages(query);
  }

  /** Mark a message handled, or back to new. */
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateContactMessageDto, @CurrentUser() user: AuthUser) {
    return this.service.updateMessage(id, body, user);
  }
}

import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermission } from '../decorators/require-permission.decorator.js';
import { AllowedWhileViewing } from './allowed-while-viewing.decorator.js';
import { ExchangeViewAsDto, StartViewAsDto } from './view-as.dto.js';
import { bearerOf } from './view-as.errors.js';
import { ViewAsService } from './view-as.service.js';

/** "View as" (owner 2026-11-23): start — users.impersonate, lower-ranked users only. */
@ApiTags('Admin · Users')
@ApiBearerAuth()
@Controller('admin/users')
export class ViewAsAdminController {
  constructor(private readonly viewAs: ViewAsService) {}

  /**
   * Start viewing the platform as this user, READ ONLY. Returns { ticket, expiresAt }: a single-use ticket valid for
   * 60 seconds, exchanged by the new tab at POST /auth/view-as/exchange. 403 VIEW_AS_NOT_ALLOWED (yourself, a Super
   * Administrator, a role not lower than yours), 404 for an unknown user. Audited (VIEW_AS_STARTED, with the reason).
   */
  @Post(':id/view-as')
  @RequirePermission('users.impersonate')
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartViewAsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request & { id?: string },
  ) {
    return this.viewAs.start(id, user, body.reason, req.id);
  }
}

/** "View as": the viewing tab's routes (public — authenticated by the ticket / the viewing token itself). */
@ApiTags('Auth')
@Controller('auth/view-as')
export class ViewAsAuthController {
  constructor(private readonly viewAs: ViewAsService) {}

  /**
   * Exchange a ticket (once, within 60 seconds) for a viewing access token: { accessToken, tokenType, expiresAt,
   * viewAs: { sessionId, actor, target, expiresAt } }. 30 minutes, no refresh token, no cookie; every change is refused
   * with it (403 VIEW_AS_READ_ONLY). 403 VIEW_AS_NOT_ALLOWED for an unknown, used or expired ticket.
   */
  @Public()
  @AllowedWhileViewing()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('exchange')
  exchange(@Body() body: ExchangeViewAsDto) {
    return this.viewAs.exchange(body.ticket);
  }

  /**
   * End the viewing session of the bearer viewing token (also after it expired). Audited (VIEW_AS_ENDED). Never
   * touches the viewer's own session or cookie. Idempotent; 200 also when there was nothing to end.
   */
  @Public()
  @AllowedWhileViewing()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('end')
  async end(@Req() req: Request) {
    const ended = await this.viewAs.endFromToken(bearerOf(req));
    return { ended, message: ended ? 'The viewing session has ended.' : 'There was no viewing session to end.' };
  }
}

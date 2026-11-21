import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { AnswerInfoRequestWithTokenDto, InfoRequestTokenDto } from './application-info-requests.dto.js';
import { ApplicationInfoRequestsService } from './application-info-requests.service.js';

/**
 * The applicant's side of "request more information" (no account yet): the one-time link e-mailed to them.
 * 410 INFO_REQUEST_LINK_INVALID when the link was used, expired, replaced, or the application was decided.
 * The token is sent in the request body, never in the URL (SEC-05): URLs reach proxy and platform access logs.
 */
@ApiTags('Auth')
@Controller('applications/info-requests')
export class ApplicationInfoRequestsController {
  constructor(private readonly service: ApplicationInfoRequestsService) {}

  /** The question, the application kind, and the details the applicant may correct with their current values. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('view')
  @HttpCode(200)
  view(@Body() body: InfoRequestTokenDto) {
    return this.service.view(body.token);
  }

  /** Answer once (and optionally correct details); the administrators are told. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('answer')
  @HttpCode(200)
  answer(@Body() body: AnswerInfoRequestWithTokenDto) {
    const { token, ...answer } = body;
    return this.service.answer(token, answer);
  }
}

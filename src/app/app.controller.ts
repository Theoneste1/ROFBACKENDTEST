import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { API_INFO_RESPONSE_DESCRIPTION } from './capabilities.js';
import { Public } from '../common/decorators/public.decorator.js';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** GET /api/v1 — basic API information. */
  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: API_INFO_RESPONSE_DESCRIPTION,
    headers: { 'Cache-Control': { description: 'Always `no-store`.', schema: { type: 'string', example: 'no-store' } } },
  })
  getInfo() {
    // Also the backend's capabilities, so a client can tell this backend from the legacy one
    // (docs/INTEGRATION.md, "Backend capabilities"). Never cached (no-store): the answer can change
    // with a deployment or a configuration change. The OpenAPI response description says the same.
    return this.appService.getInfo();
  }
}

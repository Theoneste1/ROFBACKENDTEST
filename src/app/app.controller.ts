import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { Public } from '../common/decorators/public.decorator.js';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** GET /api/v1 — basic API information. */
  @Public()
  @Get()
  getInfo() {
    return this.appService.getInfo();
  }
}

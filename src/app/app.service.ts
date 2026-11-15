import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { capabilitiesOf } from './capabilities.js';

@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}

  /** The four original fields are unchanged; `capabilities` is additive (src/app/capabilities.ts). */
  getInfo() {
    return {
      name:    'ROF LMS API',
      version: '1.0.0',
      docs:    '/api/docs',
      health:  '/health',
      capabilities: capabilitiesOf(this.config),
    };
  }
}

import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      name:    'ROF LMS API',
      version: '1.0.0',
      docs:    '/api/docs',
      health:  '/health',
    };
  }
}

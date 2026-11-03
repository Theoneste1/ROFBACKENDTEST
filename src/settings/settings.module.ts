import { Global, Module } from '@nestjs/common';
import { SettingsController, SupportController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Global()
@Module({
  controllers: [SettingsController, SupportController],
  providers:   [SettingsService],
  exports:     [SettingsService],
})
export class SettingsModule {}

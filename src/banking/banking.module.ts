import { Global, Module } from '@nestjs/common';
import { AdminBankingController, MyBankingController } from './banking.controller.js';
import { BankingService } from './banking.service.js';

/** Banking information of Teachers, Coaches and Head Coaches (owner 2026-11-25). Global: the Users list reads the status. */
@Global()
@Module({
  controllers: [MyBankingController, AdminBankingController],
  providers: [BankingService],
  exports: [BankingService],
})
export class BankingModule {}

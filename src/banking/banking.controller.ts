import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AllowedBeforeBankingDetails } from '../common/decorators/banking-step.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AdminBankingQueryDto, SaveBankingDto, SetBanksDto } from './banking.dto.js';
import { BankingService } from './banking.service.js';

/** The signed-in user's own banking information (owner 2026-11-25): Teachers, Coaches and Head Coaches only (@Roles). */
@ApiTags('Me')
@Controller('me/banking')
export class MyBankingController {
  constructor(private readonly banking: BankingService) {}

  /** What is saved, what is missing or to correct, and how this role's banks are given (fixed or from the list). */
  @Get()
  @Roles('TEACHER', 'MENTOR', 'HEAD_COACH')
  @AllowedBeforeBankingDetails()
  mine(@CurrentUser() user: AuthUser) {
    return this.banking.mine(user);
  }

  /** Save the role's fields (six for Teachers, three personal for Coaches and Head Coaches; 400 BANKING_INVALID per field). */
  @Put()
  @Roles('TEACHER', 'MENTOR', 'HEAD_COACH')
  @AllowedBeforeBankingDetails()
  save(@CurrentUser() user: AuthUser, @Body() body: SaveBankingDto) {
    return this.banking.save(user, body);
  }
}

/** An administrator's view of a person's banking information: masked; ?reveal=true in full (audited). */
@ApiTags('Admin · Users')
@Controller('admin/users')
export class AdminBankingController {
  constructor(private readonly banking: BankingService) {}

  @Get(':id/banking')
  @RequirePermission('users.manage')
  view(@Param('id', ParseUUIDPipe) id: string, @Query() q: AdminBankingQueryDto, @CurrentUser() user: AuthUser) {
    return this.banking.forAdmin(id, q.reveal === 'true', user);
  }

  /**
   * Change a Teacher's, Coach's or Head Coach's banking information (owner 2026-11-25): the person's role rules, per
   * field (400 BANKING_INVALID); audited (BANK_DETAILS_UPDATED_BY_ADMIN: which fields, never their values). Answers the
   * masked view.
   */
  @Put(':id/banking')
  @RequirePermission('users.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: SaveBankingDto, @CurrentUser() user: AuthUser) {
    return this.banking.saveForAdmin(id, body, user);
  }
}

/**
 * The bank list (owner 2026-11-27): the banks people choose and each bank's account-number rule, managed by the Super
 * Administrator in the platform. Umwalimu SACCO always stays, exactly 12 digits.
 */
@ApiTags('Admin · Banking')
@Controller('admin/banking')
export class AdminBanksController {
  constructor(private readonly banking: BankingService) {}

  /** Every bank with its rule and instruction, how many saved accounts use it and how many do not follow its rule. */
  @Get('banks')
  @Roles('SUPER_ADMIN')
  banks() {
    return this.banking.adminBanks();
  }

  /** Set the whole list at once { banks, reason } (409 BANK_IN_USE when removing a bank someone uses: switch it off). */
  @Put('banks')
  @Roles('SUPER_ADMIN')
  setBanks(@Body() body: SetBanksDto, @CurrentUser() user: AuthUser) {
    return this.banking.setBanks(body, user);
  }
}

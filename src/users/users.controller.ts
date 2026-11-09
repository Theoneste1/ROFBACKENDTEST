import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { UsersService } from './users.service.js';
import { IMPORT_MAX_BYTES, UserProvisioningService } from './user-provisioning.service.js';
import { ImportUsersQueryDto, InviteUserDto } from './dto/invite-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  ListUsersQueryDto,
  UpdateMeDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/update-user.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { permissionsFor } from '../auth/permissions.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

@ApiTags('Admin · Users')
@Controller('admin/users')
@Roles('ADMIN')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly provisioning: UserProvisioningService,
  ) {}

  /** List users with filters (role, division, grade, school, status, search). */
  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  /** Create a student, mentor or admin directly. Students require a gradeLevel. */
  @Post()
  create(@Body() body: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.usersService.create(body, user);
  }

  /**
   * Invite a person: the account is created without a password and an
   * activation link (valid 7 days) is e-mailed. Students need a gradeLevel.
   */
  @Post('invite')
  invite(@Body() body: InviteUserDto, @CurrentUser() user: AuthUser) {
    return this.provisioning.invite(body, user);
  }

  /**
   * Bulk-invite from a CSV file (field "file", UTF-8, max 1 MB / 1000 rows).
   * Header: firstName,lastName,email[,role,gradeLevel,schoolName,schoolLocation,homeLocation,username].
   * Valid rows are invited; invalid rows are reported. ?dryRun=true validates only.
   */
  @Post('import')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: ImportUsersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.provisioning.importCsv(file, query.dryRun ?? false, user);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.usersService.update(id, body, user);
  }

  /** Send a new activation link to an invited account that has not activated yet. */
  @Post(':id/resend-invitation')
  @HttpCode(200)
  resendInvitation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.provisioning.resendInvitation(id, user);
  }

  /** E-mail the user a password-reset link. */
  @Post(':id/send-password-reset')
  @HttpCode(200)
  sendPasswordReset(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.provisioning.sendPasswordReset(id, user);
  }

  /** Suspend/reactivate (`isActive`) or approve (`isApproved`) an account. */
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.usersService.updateStatus(id, body, user);
  }

  /** Only accounts without academic history can be deleted; suspend the others. */
  @Delete(':id')
  delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.usersService.delete(id, user);
  }
}

@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(private readonly usersService: UsersService) {}

  /** The current user's profile, division and school. */
  @Get()
  @Authenticated()
  getMe(@CurrentUser() user: AuthUser) {
    return this.usersService.getMe(user.id);
  }

  @Patch()
  @Authenticated()
  updateMe(@CurrentUser() user: AuthUser, @Body() body: UpdateMeDto) {
    return this.usersService.updateMe(user.id, body);
  }

  /** What the current user's role may do (for showing/hiding UI). */
  @Get('permissions')
  @Authenticated()
  permissions(@CurrentUser() user: AuthUser) {
    return { role: user.role, permissions: permissionsFor(user.role) };
  }

  /** The current student's enrolment history (one row per academic year). */
  @Get('enrollments')
  @Roles('STUDENT')
  enrollments(@CurrentUser() user: AuthUser) {
    return this.usersService.getMyEnrollments(user.id);
  }
}

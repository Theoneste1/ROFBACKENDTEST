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
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Response } from 'express';

import { UsersService } from './users.service.js';
import { AvatarService } from './avatar.service.js';
import { uploadOptions } from '../common/storage/upload-options.js';
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
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { PermissionService } from '../auth/permission.service.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

@ApiTags('Admin · Users')
@Controller('admin/users')
export class UsersController {
  constructor(
    private readonly avatars: AvatarService,
    private readonly usersService: UsersService,
    private readonly provisioning: UserProvisioningService,
  ) {}

  /** List users with filters (role, division, grade, school, status, search). */
  @Get()
  @RequirePermission('users.manage')
  findAll(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  /** Create a student, mentor or admin directly. Students require a gradeLevel. */
  @Post()
  @RequirePermission('users.manage')
  create(@Body() body: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.usersService.create(body, user);
  }

  /**
   * Invite a person: the account is created without a password and an
   * activation link (valid 7 days) is e-mailed. Students need a gradeLevel.
   */
  @Post('invite')
  @RequirePermission('users.manage')
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
  @RequirePermission('users.manage')
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: ImportUsersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.provisioning.importCsv(file, query.dryRun ?? false, user);
  }

  @Get(':id')
  @RequirePermission('users.manage')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('users.manage')
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
  @RequirePermission('users.manage')
  resendInvitation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.provisioning.resendInvitation(id, user);
  }

  /** E-mail the user a password-reset link. */
  @Post(':id/send-password-reset')
  @HttpCode(200)
  @RequirePermission('users.manage')
  sendPasswordReset(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.provisioning.sendPasswordReset(id, user);
  }

  /** Suspend/reactivate (`isActive`) or approve (`isApproved`) an account. */
  @Patch(':id/status')
  @RequirePermission('users.manage')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.usersService.updateStatus(id, body, user);
  }

  /** Only accounts without academic history can be deleted; suspend the others. */
  @Delete(':id')
  @RequirePermission('users.manage')
  delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.usersService.delete(id, user);
  }

  /**
   * Set or replace an account's profile picture (multipart field `file`: JPEG, PNG or WebP, at most 2 MB).
   * Only for an account whose current role the caller may manage (an ADMIN never a SUPER_ADMIN). Returns the
   * account. 400 FILE_REQUIRED / EMPTY_FILE, 413 PAYLOAD_TOO_LARGE (over 2 MB), 415 FILE_TYPE_NOT_ALLOWED.
   */
  @Put(':id/avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('AVATAR', 1)))
  @RequirePermission('users.manage')
  setAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.avatars.setFor(id, user, file);
  }

  /** Remove an account's profile picture (idempotent). Same rule as PUT. Returns the account. */
  @Delete(':id/avatar')
  @RequirePermission('users.manage')
  removeAvatar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.avatars.removeFor(id, user);
  }
}

@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(
    private readonly avatars: AvatarService,
    private readonly usersService: UsersService,
    private readonly permissionService: PermissionService,
  ) {}

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

  /**
   * Set or replace the current user's profile picture (multipart field `file`: JPEG, PNG or WebP, at most
   * 2 MB, checked from the file's bytes). Returns the profile, whose avatarUrl is the new versioned link.
   * 400 FILE_REQUIRED / EMPTY_FILE, 413 PAYLOAD_TOO_LARGE (over 2 MB), 415 FILE_TYPE_NOT_ALLOWED.
   */
  @Put('avatar')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('AVATAR', 1)))
  setAvatar(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.avatars.setOwn(user, file);
  }

  /** Remove the current user's profile picture (idempotent). Returns the profile. */
  @Delete('avatar')
  @Authenticated()
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.avatars.removeOwn(user);
  }

  /** What the current user's role may do (for showing/hiding UI). */
  @Get('permissions')
  @Authenticated()
  permissions(@CurrentUser() user: AuthUser) {
    return this.permissionService.describe(user);
  }

  /** The current student's enrolment history (one row per academic year). */
  @Get('enrollments')
  @Roles('STUDENT')
  enrollments(@CurrentUser() user: AuthUser) {
    return this.usersService.getMyEnrollments(user.id);
  }
}

/** Profile pictures, viewable by any signed-in user (they appear next to names across the app). */
@ApiTags('Users')
@Controller('users')
export class UserAvatarController {
  constructor(private readonly avatars: AvatarService) {}

  /**
   * The account's current profile picture, inline, with Cache-Control: private, max-age=86400 (the link in
   * avatarUrl is versioned) and X-Content-Type-Options: nosniff. 404 when the account has none.
   */
  @Get(':id/avatar')
  @Authenticated()
  async avatar(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    await this.avatars.send(id, res);
  }
}

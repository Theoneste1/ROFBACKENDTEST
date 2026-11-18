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
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';

import { UsersService } from './users.service.js';
import { AvatarService } from './avatar.service.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { RegistrationTimelineService } from './registration-timeline.service.js';
import { IMPORT_MAX_BYTES, UserProvisioningService } from './user-provisioning.service.js';
import { ImportUsersQueryDto, InviteUserDto } from './dto/invite-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  ListUsersQueryDto,
  CorrectDateOfBirthDto,
  SetDateOfBirthDto,
  UpdateMeDto,
  UpdateUserDto,
  UpdateUserStatusDto,
  ChangeAccountStatusDto,
} from './dto/update-user.dto.js';
import { AccountStatusService } from './account-status.service.js';
import { PaginationQueryDto } from '../common/pagination.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { PermissionService } from '../auth/permission.service.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';
import { AllowedBeforeDateOfBirth } from '../common/decorators/date-of-birth-step.decorator.js';

@ApiTags('Admin · Users')
@Controller('admin/users')
export class UsersController {
  constructor(
    private readonly avatars: AvatarService,
    private readonly usersService: UsersService,
    private readonly provisioning: UserProvisioningService,
    private readonly accountStatus: AccountStatusService,
    private readonly registrationTimelineService: RegistrationTimelineService,
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

  /**
   * Correct a student's date of birth (owner approval 2026-11-18): { dateOfBirth: "YYYY-MM-DD", reason } — the
   * registration rules; the reason is mandatory. Recorded with the old and new dates (GET …/date-of-birth-history).
   * 400 VALIDATION_FAILED / NOT_A_STUDENT, 409 DATE_OF_BIRTH_UNCHANGED. Returns the account.
   */
  @Put(':id/date-of-birth')
  @RequirePermission('users.manage')
  correctDateOfBirth(@Param('id', ParseUUIDPipe) id: string, @Body() body: CorrectDateOfBirthDto, @CurrentUser() user: AuthUser) {
    return this.usersService.correctDateOfBirth(id, body, user);
  }

  /** The date-of-birth history: Administrator corrections (old and new dates, reason, who, when) and the first-sign-in entry. */
  @Get(':id/date-of-birth-history')
  @RequirePermission('users.manage')
  dateOfBirthHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.usersService.dateOfBirthHistory(id, user);
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

  /**
   * Suspend (`isActive: false`), lift a suspension or reactivate (`isActive: true`), or approve (`isApproved`) an
   * account. Compatible view of the account states; POST :id/status-changes records a reason and covers every state.
   */
  @Patch(':id/status')
  @RequirePermission('users.manage')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request & { id?: string },
  ) {
    return this.usersService.updateStatus(id, body, user, req.id ?? null);
  }

  /**
   * Change an account's state (capability accountStates): ACTIVE, DEACTIVATED, SUSPENDED or ARCHIVED, with a reason
   * (3–500 characters; required except to reactivate or lift a suspension). Restoring an archived account also needs
   * `confirm: true`. Leaving ACTIVE ends every session. Returning to ACTIVE sets the state only; `stillBlockedBy` lists
   * what still prevents sign-in (NOT_ACTIVATED, PENDING_APPROVAL, LOCKED, ROLE_DISABLED).
   * Needs users.changeStatus, users.suspend or users.archive (by transition) and the right to manage the account's
   * role. 409 STATUS_UNCHANGED / INVALID_STATUS_TRANSITION / LAST_SUPER_ADMIN, 400 REASON_REQUIRED /
   * CANNOT_CHANGE_OWN_STATUS / CONFIRMATION_REQUIRED, 403 PERMISSION_REQUIRED / ROLE_NOT_ASSIGNABLE.
   */
  @Post(':id/status-changes')
  @HttpCode(200)
  @RequirePermission('users.manage')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangeAccountStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request & { id?: string },
  ) {
    return this.accountStatus.change(id, { toStatus: body.toStatus, reason: body.reason, confirm: body.confirm }, user, { requestId: req.id ?? null });
  }

  /**
   * Registration timeline (REG-13): the current stages and every registration-related event, oldest first
   * (registration / invitation, application, activation, approval, state and role changes, school claims).
   */
  @Get(':id/registration-timeline')
  @RequirePermission('users.manage')
  registrationTimeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.registrationTimelineService.timeline(id);
  }

  /** The account's state changes, newest first (who, when, from, to, reason). */
  @Get(':id/status-history')
  @RequirePermission('users.viewStatusHistory')
  statusHistory(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.accountStatus.history(id, query);
  }

  /**
   * Accounts are never deleted through the API (account states, 2026-11-16): always 409 PERMANENT_DELETION_DISABLED
   * for an account the caller may manage. Archive it instead (POST :id/status-changes, toStatus ARCHIVED).
   */
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

  /** The current user's profile, division and school; `dateOfBirthRequired` true: PUT /me/date-of-birth first. */
  @Get()
  @Authenticated()
  @AllowedBeforeDateOfBirth()
  getMe(@CurrentUser() user: AuthUser) {
    return this.usersService.getMe(user.id);
  }

  /**
   * A student who has no date of birth yet (created by an Administrator, invited or imported) gives it here; until
   * then other routes answer 403 DATE_OF_BIRTH_REQUIRED (owner decision 9.3). 400 VALIDATION_FAILED (registration
   * rules), 409 DATE_OF_BIRTH_ALREADY_SET. Returns the profile.
   */
  @Put('date-of-birth')
  @Roles('STUDENT')
  @AllowedBeforeDateOfBirth()
  setDateOfBirth(@CurrentUser() user: AuthUser, @Body() body: SetDateOfBirthDto) {
    return this.usersService.setOwnDateOfBirth(user, body.dateOfBirth);
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
  @AllowedBeforeDateOfBirth()
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

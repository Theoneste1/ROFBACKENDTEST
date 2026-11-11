import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import { AdminSchoolsService } from './admin-schools.service.js';
import { CreateSchoolDto, ListAdminSchoolsDto, SetSchoolActiveDto, UpdateSchoolDto } from './dto/admin-school.dto.js';

/**
 * School administration (schools.manage: Administrators and Super Admins only). Every change is
 * atomic with its audit record. Creating a school here is the only way the application creates
 * one; invitations, CSV imports and registration only refer to existing schools.
 */
@ApiTags('Admin · Schools')
@ApiBearerAuth()
@Controller('admin/schools')
export class AdminSchoolsController {
  constructor(private readonly service: AdminSchoolsService) {}

  /** Every school — official, Administrator-created and legacy; active and inactive — with student counts. */
  @Get()
  @RequirePermission('schools.manage')
  list(@Query() q: ListAdminSchoolsDto) {
    return this.service.list(q);
  }

  /** A school with what refers to it: students, verified students, pending claims, Teacher assignments, enrolments. */
  @Get(':id')
  @RequirePermission('schools.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  /** The school's students with the status of their current claim for this school. */
  @Get(':id/students')
  @RequirePermission('schools.manage')
  students(@Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.service.students(id, q);
  }

  /** Create a school (409 SCHOOL_NAME_TAKEN / SCHOOL_CODE_TAKEN / POSSIBLE_DUPLICATE). */
  @Post()
  @RequirePermission('schools.manage')
  create(@Body() dto: CreateSchoolDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  /** Edit a school; its id, students, claims and Teacher assignments are unchanged. */
  @Patch(':id')
  @RequirePermission('schools.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSchoolDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, dto, user);
  }

  /** Deactivate or reactivate (reason required); the response lists what refers to the school. */
  @Patch(':id/active')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSchoolActiveDto, @CurrentUser() user: AuthUser) {
    return this.service.setActive(id, dto, user);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AcademicYearsService } from './academic-years.service.js';
import {
  ActivateAcademicYearDto,
  CreateAcademicYearDto,
  ListEnrollmentsDto,
  UpdateAcademicYearDto,
  UpdateEnrollmentDto,
} from './dto/academic-year.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

@ApiTags('Academic years')
@Controller('academic-years')
export class AcademicYearsController {
  constructor(private readonly years: AcademicYearsService) {}

  /** All academic years (newest first), e.g. for filters. */
  @Get()
  @Authenticated()
  list() {
    return this.years.list();
  }

  @Get('current')
  @Authenticated()
  current() {
    return this.years.current();
  }
}

@ApiTags('Admin · Academic years')
@Controller('admin')
export class AdminAcademicYearsController {
  constructor(private readonly years: AcademicYearsService) {}

  /** Plan a new academic year (status PLANNED). */
  @Post('academic-years')
  @RequirePermission('academicYears.manage')
  create(@Body() body: CreateAcademicYearDto, @CurrentUser() user: AuthUser) {
    return this.years.create(body, user);
  }

  @Get('academic-years/:id')
  @RequirePermission('academicYears.manage')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.years.findOne(id);
  }

  @Patch('academic-years/:id')
  @RequirePermission('academicYears.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAcademicYearDto, @CurrentUser() user: AuthUser) {
    return this.years.update(id, body, user);
  }

  /**
   * Start the year: closes the current one (archiving its assignments) and
   * rolls every active student over — promoted one grade when requested.
   */
  @Post('academic-years/:id/activate')
  @HttpCode(200)
  @RequirePermission('academicYears.manage')
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() body: ActivateAcademicYearDto, @CurrentUser() user: AuthUser) {
    return this.years.activate(id, body, user);
  }

  @Get('academic-years/:id/enrollments')
  @RequirePermission('academicYears.manage')
  enrollments(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListEnrollmentsDto) {
    return this.years.listEnrollments(id, query);
  }

  /** Correct a grade or withdraw a student (current year only). */
  @Patch('enrollments/:id')
  @RequirePermission('enrollments.manage')
  updateEnrollment(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateEnrollmentDto, @CurrentUser() user: AuthUser) {
    return this.years.updateEnrollment(id, body, user);
  }
}

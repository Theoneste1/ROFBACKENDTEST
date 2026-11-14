import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, ValidateIf } from 'class-validator';

import { SchoolsService } from './schools.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';

class ListSchoolsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  search?: string;
}

/** Name, code or place (2+ characters), and/or a Province → District → Sector (active Rwandan schools, with or without an official code). */
class SearchSchoolsDto {
  @ValidateIf((o: SearchSchoolsDto) => o.q !== undefined || (!o.district && !o.sector))
  @IsString()
  @Length(2, 100)
  q?: string;

  @IsOptional() @IsString() @Length(1, 100) province?: string;
  @IsOptional() @IsString() @Length(1, 100) district?: string;
  @IsOptional() @IsString() @Length(1, 100) sector?: string;

  /**
   * Only schools a Teacher may name: an official code, or created AND verified by an administrator
   * (owner decision 2026-11-14). Default false (the student list).
   */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() teacherEligible?: boolean;

  /** Only schools offering this education level (PPR, PR, OL, AL, PE). */
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)) @IsString() @Length(1, 10) level?: string;
}

@ApiTags('Schools')
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /**
   * Public, for the sign-up form: active Rwandan schools by name, code or place (max 10), or every
   * active school of a district / sector (Rwanda: Province → District → Sector → School). Schools
   * without an official code are included with `code: null` (owner decision 2026-11-14): choose
   * them by `id` (schoolId) at registration and in a school claim.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  search(@Query() query: SearchSchoolsDto) {
    return this.schoolsService.search(query.q, { province: query.province, district: query.district, sector: query.sector, level: query.level, teacherEligible: query.teacherEligible });
  }

  /** Public: Rwanda's provinces → districts → sectors that have official schools. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('locations')
  locations() {
    return this.schoolsService.locations();
  }

  /** ADMIN: schools with student counts. Deprecated: use GET /admin/schools (same callers; unchanged guard). */
  @Get()
  @ApiOperation({ deprecated: true })
  @Roles('ADMIN', 'SUPER_ADMIN')
  findAll(@Query() query: ListSchoolsDto) {
    return this.schoolsService.findAll(query);
  }

  /** ADMIN: a school and its students (paginated). Deprecated: use GET /admin/schools/:id and …/students. */
  @Get(':id')
  @ApiOperation({ deprecated: true })
  @Roles('ADMIN', 'SUPER_ADMIN')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.schoolsService.findOne(id, query);
  }
}

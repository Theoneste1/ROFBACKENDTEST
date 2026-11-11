import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';

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

/** Name or code (2+ characters), and/or a Province → District → Sector (official schools only). */
class SearchSchoolsDto {
  @ValidateIf((o: SearchSchoolsDto) => o.q !== undefined || (!o.district && !o.sector))
  @IsString()
  @Length(2, 100)
  q?: string;

  @IsOptional() @IsString() @Length(1, 100) province?: string;
  @IsOptional() @IsString() @Length(1, 100) district?: string;
  @IsOptional() @IsString() @Length(1, 100) sector?: string;

  /** Only schools offering this education level (PPR, PR, OL, AL, PE). */
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)) @IsString() @Length(1, 10) level?: string;
}

@ApiTags('Schools')
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /**
   * Public, for the sign-up form: official schools by name or code (max 10), or every
   * official school of a district / sector (Rwanda: Province → District → Sector → School).
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  search(@Query() query: SearchSchoolsDto) {
    return this.schoolsService.search(query.q, { province: query.province, district: query.district, sector: query.sector, level: query.level });
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

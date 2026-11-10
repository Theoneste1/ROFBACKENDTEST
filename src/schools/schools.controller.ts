import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

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

class SearchSchoolsDto {
  @IsString()
  @Length(2, 100)
  q: string;
}

@ApiTags('Schools')
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /** Public autocomplete for the sign-up form (max 10 matches). */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  search(@Query() query: SearchSchoolsDto) {
    return this.schoolsService.search(query.q);
  }

  /** ADMIN: schools with student counts. */
  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  findAll(@Query() query: ListSchoolsDto) {
    return this.schoolsService.findAll(query);
  }

  /** ADMIN: a school and its students (paginated). */
  @Get(':id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.schoolsService.findOne(id, query);
  }
}

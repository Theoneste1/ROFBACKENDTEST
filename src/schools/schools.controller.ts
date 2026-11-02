import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SchoolsService } from './schools.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@Controller('schools')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /** List all schools with student counts. ADMIN only. */
  @Get()
  findAll() {
    return this.schoolsService.findAll();
  }

  /** Get a school and its enrolled students. ADMIN only. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.schoolsService.findOne(id);
  }
}

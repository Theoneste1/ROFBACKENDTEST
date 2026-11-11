import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import { AdminSchoolsService } from './admin-schools.service.js';
import { SchoolDirectoryDataService } from './directory/school-directory-data.service.js';
import { PutSchoolContactsDto, PutSchoolOfferingsDto, SchoolContactsQueryDto, VerifySchoolContactDto } from './directory/school-directory.dto.js';
import { CreateSchoolDto, ListAdminSchoolsDto, SetSchoolActiveDto, UpdateSchoolDto } from './dto/admin-school.dto.js';
import { ImportSchoolsQueryDto, ImportTemplateQueryDto } from './import/school-import.dto.js';
import { IMPORT_MAX_BYTES } from './import/school-import.parser.js';
import { SchoolImportService } from './import/school-import.service.js';
import { csvTemplate, TEMPLATE_CSV_NAME, TEMPLATE_XLSX_NAME, XLSX_CONTENT_TYPE, xlsxTemplate } from './import/school-import.template.js';

/**
 * School administration (schools.manage: Administrators and Super Admins only). Every change is
 * atomic with its audit record. Creating a school here is the only way the application creates
 * one; invitations, CSV imports and registration only refer to existing schools.
 */
@ApiTags('Admin · Schools')
@ApiBearerAuth()
@Controller('admin/schools')
export class AdminSchoolsController {
  constructor(
    private readonly service: AdminSchoolsService,
    private readonly importer: SchoolImportService,
    private readonly directory: SchoolDirectoryDataService,
  ) {}

  /** The import template: CSV (header row) or XLSX (a Schools sheet + an Instructions sheet). Declared before :id. */
  @Get('import-template')
  @RequirePermission('schools.manage')
  async importTemplate(@Query() q: ImportTemplateQueryDto, @Res() res: Response) {
    const xlsx = q.format === 'xlsx';
    res.setHeader('Content-Type', xlsx ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${xlsx ? TEMPLATE_XLSX_NAME : TEMPLATE_CSV_NAME}"`);
    res.send(xlsx ? await xlsxTemplate() : csvTemplate());
  }

  /**
   * Import schools from a .csv or .xlsx file (at most 1 MB / 1,000 schools). All-or-nothing: any
   * invalid row → 422 and nothing is created. Possible duplicates need confirmPossibleDuplicates
   * with the reviewToken of a dry run (409 when unconfirmed or changed since the review).
   * dryRun=true validates only (200); a successful import returns 201.
   */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  @RequirePermission('schools.manage')
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() q: ImportSchoolsQueryDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.importer.run(file, q, user);
    res.status(result.dryRun ? 200 : 201);
    return result;
  }

  /** Directory reference data: education levels and programmes (needsReview: not yet reviewed). Declared before :id. */
  @Get('reference-data')
  @RequirePermission('schools.manage')
  referenceData() {
    return this.directory.referenceData();
  }

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

  /**
   * The school's contacts (Administrators only). Contacts are never returned by public search,
   * registration or exports; school representatives (S3) see only verified contacts authorised for them.
   */
  @Get(':id/contacts')
  @RequirePermission('schools.manage')
  contacts(@Param('id', ParseUUIDPipe) id: string, @Query() q: SchoolContactsQueryDto) {
    return this.directory.contacts(id, q.includeRemoved ?? false);
  }

  /**
   * Replace the school's active contacts (audited with masked values). Removed and replaced
   * contacts are kept (includeRemoved lists them); a new or changed value is unverified.
   */
  @Put(':id/contacts')
  @RequirePermission('schools.manage')
  putContacts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PutSchoolContactsDto, @CurrentUser() user: AuthUser) {
    return this.directory.putContacts(id, dto, user);
  }

  /** Verify a contact; visibility REPRESENTATIVES also authorises it for the school's representatives (audited). */
  @Post(':id/contacts/:contactId/verify')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  verifyContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: VerifySchoolContactDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.directory.verifyContact(id, contactId, dto, user);
  }

  /** The school's education levels and programmes. */
  @Get(':id/offerings')
  @RequirePermission('schools.manage')
  offerings(@Param('id', ParseUUIDPipe) id: string) {
    return this.directory.offerings(id);
  }

  /** Replace the school's education levels and programmes (audited). */
  @Put(':id/offerings')
  @RequirePermission('schools.manage')
  putOfferings(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PutSchoolOfferingsDto, @CurrentUser() user: AuthUser) {
    return this.directory.putOfferings(id, dto, user);
  }

  /** The source records the school was matched with and — only with audit.view — its audit entries (newest first). */
  @Get(':id/history')
  @RequirePermission('schools.manage')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQueryDto, @CurrentUser() user: AuthUser) {
    return this.directory.history(id, q, user);
  }

  /** Create a school (409 SCHOOL_CODE_TAKEN / POSSIBLE_DUPLICATE). Names may repeat (M12). */
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

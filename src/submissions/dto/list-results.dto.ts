import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.js';

export class ListResultsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() academicYearId?: string;
}

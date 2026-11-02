import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../common/pagination.js';

export class CreateMentorAssignmentDto {
  @IsUUID()
  mentorId: string;

  @IsUUID()
  courseId: string;

  @IsUUID()
  divisionId: string;
}

export class ListMentorAssignmentsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() mentorId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() divisionId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}

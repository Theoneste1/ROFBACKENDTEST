import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SubmissionStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export class ListSubmissionsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsUUID() mentorId?: string;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsEnum(SubmissionStatus) status?: SubmissionStatus;
}

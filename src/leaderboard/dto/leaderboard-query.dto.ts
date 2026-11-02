import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.js';

export class LeaderboardQueryDto extends PaginationQueryDto {
  /** Required for mentors/admins; students always see their own division. */
  @IsOptional()
  @IsUUID()
  divisionId?: string;

  /** Narrow the student board to one school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}

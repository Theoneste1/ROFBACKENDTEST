import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.js';

export class ListCommentsDto extends PaginationQueryDto {
  /**
   * Course threads only: which division's thread to read.
   * Ignored for students (always their own division); required for mentors;
   * optional for admins (omit to see all divisions).
   */
  @IsOptional()
  @IsUUID()
  divisionId?: string;
}

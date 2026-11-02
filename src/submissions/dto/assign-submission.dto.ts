import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DistributionStrategy } from '../submissions.constants.js';

export class AssignSubmissionDto {
  /** Must be a mentor assigned to the assignment's course × division. */
  @IsUUID()
  mentorId: string;
}

export class DistributeSubmissionsDto {
  /** Defaults to the `submissions.defaultDistributionStrategy` setting. */
  @IsOptional()
  @IsEnum(DistributionStrategy)
  strategy?: DistributionStrategy;

  /**
   * Restrict distribution to these mentors. Omit to use every mentor assigned
   * to the assignment's course × division.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  mentorIds?: string[];
}

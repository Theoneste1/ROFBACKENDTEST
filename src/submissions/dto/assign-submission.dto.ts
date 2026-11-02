import { IsUUID } from 'class-validator';

export class AssignSubmissionDto {
  @IsUUID()
  mentorId: string;
}

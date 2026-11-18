import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { trim } from '../auth/dto/password.rules.js';

/** POST /admin/teacher-applications/:id/request-info and POST /mentor-requests/:id/request-info. */
export class RequestApplicationInfoDto {
  /** The question shown to the applicant (5–2000 characters). */
  @IsString() @Length(5, 2000) @Transform(trim)
  question: string;
}

/**
 * POST /applications/info-requests/view. The one-time link's token travels in the body, never in the URL (SEC-05: URLs
 * end up in proxy and platform access logs).
 */
export class InfoRequestTokenDto {
  @IsString() @Length(16, 200)
  token: string;
}

/**
 * POST /applications/info-requests/answer (with `token`, see InfoRequestTokenDto). `answer` is required; the other fields correct the application where the
 * application kind allows it (Teacher: phone, position, yearsOfExperience; Coach: phone, affiliation, expertise,
 * relevantExperience, yearsOfExperience, occupation) and are ignored otherwise.
 */
export class AnswerInfoRequestDto {
  @IsString() @Length(1, 4000) @Transform(trim)
  answer: string;

  @IsOptional() @IsString() @Length(1, 40) @Transform(trim)
  phone?: string;

  @IsOptional() @IsString() @Length(2, 100) @Transform(trim)
  position?: string;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  yearsOfExperience?: number;

  @IsOptional() @IsString() @Length(2, 200) @Transform(trim)
  affiliation?: string;

  @IsOptional() @IsString() @Length(2, 1000) @Transform(trim)
  expertise?: string;

  @IsOptional() @IsString() @Length(2, 2000) @Transform(trim)
  relevantExperience?: string;

  @IsOptional() @IsString() @Length(2, 200) @Transform(trim)
  occupation?: string;
}

/** POST /applications/info-requests/answer: the token (body, never the URL) and the answer. */
export class AnswerInfoRequestWithTokenDto extends AnswerInfoRequestDto {
  @IsString() @Length(16, 200)
  token: string;
}

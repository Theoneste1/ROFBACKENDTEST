import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * How recipients are selected for a bulk send.
 *
 * EXPLICIT  – caller provides a list of user IDs.
 * ROLE      – all users with a given role.
 * DIVISION  – all students in a division (Junior or Senior).
 * SCHOOL    – all students in a given school.
 * ALL       – every active, approved user on the platform.
 */
export enum RecipientMode {
  EXPLICIT = 'EXPLICIT',
  ROLE     = 'ROLE',
  DIVISION = 'DIVISION',
  SCHOOL   = 'SCHOOL',
  ALL      = 'ALL',
}

export class SendEmailDto {
  /**
   * Idempotency key supplied by the caller.
   * Re-submitting the same key returns the existing job rather than
   * dispatching duplicate messages. Use a UUID or a stable hash.
   */
  @IsString()
  @Length(8, 128)
  idempotencyKey: string;

  @IsEnum(RecipientMode)
  recipientMode: RecipientMode;

  /**
   * Required when recipientMode is EXPLICIT.
   * Maximum 500 recipients per request.
   */
  @ValidateIf((o) => o.recipientMode === RecipientMode.EXPLICIT)
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one recipient user ID is required.' })
  @ArrayMaxSize(500, { message: 'Maximum 500 explicit recipients per request.' })
  @IsUUID('all', { each: true, message: 'Each recipient must be a valid user ID (UUID).' })
  recipientUserIds?: string[];

  /**
   * Required when recipientMode is ROLE.
   * Valid values: STUDENT | MENTOR | ADMIN
   */
  @ValidateIf((o) => o.recipientMode === RecipientMode.ROLE)
  @IsString()
  @IsEnum(['STUDENT', 'MENTOR', 'ADMIN'], {
    message: 'recipientRole must be STUDENT, MENTOR, or ADMIN.',
  })
  recipientRole?: string;

  /**
   * Required when recipientMode is DIVISION.
   */
  @ValidateIf((o) => o.recipientMode === RecipientMode.DIVISION)
  @IsUUID()
  recipientDivisionId?: string;

  /**
   * Required when recipientMode is SCHOOL.
   */
  @ValidateIf((o) => o.recipientMode === RecipientMode.SCHOOL)
  @IsUUID()
  recipientSchoolId?: string;

  @IsString()
  @Length(2, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  subject: string;

  /**
   * Plain-text message body.
   * HTML is intentionally not supported to reduce XSS risk and simplify
   * the implementation. Add HTML support here when needed.
   */
  @IsString()
  @Length(5, 10_000)
  @Transform(({ value }: { value: string }) => value?.trim())
  body: string;
}

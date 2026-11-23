import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StartViewAsDto {
  /** Why the administrator is viewing as this user (optional, kept in the audit log). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}

export class ExchangeViewAsDto {
  /** The single-use ticket returned by POST /admin/users/:id/view-as. */
  @IsString()
  @Length(20, 200)
  ticket: string;
}

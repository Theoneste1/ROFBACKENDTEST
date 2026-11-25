import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PUT /me/banking: the six fields. Their rules (required, the fixed Umwalimu SACCO, the bank list, account-number
 * digits) are checked by the service (banking-rules.ts), which answers per field; here only the type and a length cap.
 */
export class SaveBankingDto {
  @IsOptional() @IsString() @MaxLength(200) personalAccountName?: string;
  @IsOptional() @IsString() @MaxLength(200) personalBankName?: string;
  @IsOptional() @IsString() @MaxLength(40) personalAccountNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) schoolAccountName?: string;
  @IsOptional() @IsString() @MaxLength(200) schoolBankName?: string;
  @IsOptional() @IsString() @MaxLength(40) schoolAccountNumber?: string;
}

/** GET /admin/users/:id/banking?reveal=true: the account numbers in full (audited). */
export class AdminBankingQueryDto {
  @IsOptional() @Transform(({ value }) => (value === 'true' || value === true ? 'true' : value)) @IsIn(['true', 'false']) reveal?: 'true' | 'false';
}

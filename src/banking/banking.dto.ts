import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

/**
 * PUT /me/banking: the role's fields — all six for Teachers, the three personal ones for Coaches and Head Coaches (school
 * fields a coach sends are ignored, never saved). Their rules (required, the fixed Umwalimu SACCO, the bank list, the
 * teachers' 12-digit personal and school numbers) are checked by the service (banking-rules.ts), which answers per field. Here only the type
 * and a length cap — a technical guard against oversized input, not an agreed rule (far above any real value).
 */
export class SaveBankingDto {
  @IsOptional() @IsString() @MaxLength(200) personalAccountName?: string;
  @IsOptional() @IsString() @MaxLength(200) personalBankName?: string;
  @IsOptional() @IsString() @MaxLength(40) personalAccountNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) schoolAccountName?: string;
  @IsOptional() @IsString() @MaxLength(200) schoolBankName?: string;
  @IsOptional() @IsString() @MaxLength(40) schoolAccountNumber?: string;
  /**
   * The saved banks the user explicitly agrees to replace with Umwalimu SACCO (GET /me/banking `conflicts`). Without
   * it, a conflicting saved bank is never replaced: 400 BANKING_INVALID names the field (confirmationNeeded).
   */
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['personalBankName', 'schoolBankName'], { each: true })
  confirmReplace?: Array<'personalBankName' | 'schoolBankName'>;
}

/** One bank of the list the Super Administrator manages: its name, whether it can be chosen, its digits rule (null: general). */
export class BankOptionDto {
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(40) minDigits?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(40) maxDigits?: number | null;
}

/** PUT /admin/banking/banks (Super Administrator): the whole list at once and the reason (audit log). */
export class SetBanksDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BankOptionDto)
  banks!: BankOptionDto[];

  @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @Length(3, 500)
  reason!: string;
}

/** GET /admin/users/:id/banking?reveal=true: the account numbers in full (audited). */
export class AdminBankingQueryDto {
  @IsOptional() @Transform(({ value }) => (value === 'true' || value === true ? 'true' : value)) @IsIn(['true', 'false']) reveal?: 'true' | 'false';
}

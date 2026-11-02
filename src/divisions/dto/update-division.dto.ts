import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../auth/dto/password.rules.js';

export class UpdateDivisionDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

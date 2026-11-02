import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateStudyGroupDto {
  @IsOptional()
  @IsString()
  @Length(2, 150)
  @Transform(({ value }: { value: string }) => value?.trim())
  name?: string;

  @IsOptional()
  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  @Transform(({ value }: { value: string }) => value?.trim())
  tags?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

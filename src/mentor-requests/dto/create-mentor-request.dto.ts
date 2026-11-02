import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { MentorRequestStatus } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export class CreateMentorRequestDto {
  @IsString()
  @Length(2, 50)
  @Transform(trim)
  firstName: string;

  @IsString()
  @Length(2, 50)
  @Transform(trim)
  lastName: string;

  @IsString()
  @Length(3, 30)
  @Matches(/^[a-z0-9._-]+$/, { message: 'Username may contain letters, digits, ".", "_" and "-" only.' })
  @Transform(lower)
  username: string;

  @IsEmail()
  @Transform(lower)
  email: string;

  @IsStrongPassword()
  password: string;
}

export class ListMentorRequestsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MentorRequestStatus)
  status?: MentorRequestStatus;
}

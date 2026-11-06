import { IsEmail, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ContactMessageStatus } from '../../generated/prisma/client.js';
import { lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';

/** Public contact form (POST /public/contact). Unknown fields are rejected by the global ValidationPipe. */
export class CreateContactMessageDto {
  @IsString()
  @Transform(trim)
  @Length(2, 100)
  fullName: string;

  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @Transform(trim)
  @Length(3, 150)
  subject: string;

  @IsString()
  @Transform(trim)
  @Length(10, 5000)
  message: string;

  /**
   * Honeypot: a field hidden from people. Bots fill it in; when it is not
   * empty the message is accepted silently and discarded.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class ListContactMessagesDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ContactMessageStatus)
  status?: ContactMessageStatus;
}

export class UpdateContactMessageDto {
  @IsEnum(ContactMessageStatus)
  status: ContactMessageStatus;
}

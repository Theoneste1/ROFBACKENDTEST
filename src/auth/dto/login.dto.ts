import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { lower } from './password.rules.js';

export class LoginDto {
  /** Username or e-mail address (case-insensitive). */
  @IsString()
  @Length(3, 254)
  @Transform(lower)
  username: string;

  @IsString()
  @Length(1, 100)
  password: string;
}

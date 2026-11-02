import { IsString, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(3, 30)
  username: string;

  @IsString()
  @Length(8, 100)
  password: string;
}
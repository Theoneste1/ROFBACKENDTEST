import {
  IsEmail,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateMentorRequestDto {
  @IsString()
  @Length(2, 50)
  firstName: string;

  @IsString()
  @Length(2, 50)
  lastName: string;

  @IsString()
  @Length(3, 30)
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @Length(8, 100)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'Password must contain letters and numbers.',
  })
  password: string;
}
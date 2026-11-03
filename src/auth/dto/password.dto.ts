import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsStrongPassword, lower } from './password.rules.js';

export class RefreshTokenDto {
  /** Optional when the refresh token is sent as the httpOnly cookie. */
  @IsOptional()
  @IsString()
  @Length(20, 200)
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  @Transform(lower)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(20, 200)
  token: string;

  @IsStrongPassword()
  newPassword: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(1, 100)
  currentPassword: string;

  @IsStrongPassword()
  newPassword: string;
}

export class ActivationTokenDto {
  @IsString()
  @Length(20, 200)
  token: string;
}

export class ActivateAccountDto {
  @IsString()
  @Length(20, 200)
  token: string;

  /** Required for invitations; omitted for e-mail verification. */
  @IsOptional()
  @IsStrongPassword()
  password?: string;
}

export class ResendActivationDto {
  @IsEmail()
  @Transform(lower)
  email: string;
}

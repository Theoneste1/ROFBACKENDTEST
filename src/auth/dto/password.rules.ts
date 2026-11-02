import { applyDecorators } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';

/** Shared password policy: 8–100 characters with at least one letter and one number. */
export const IsStrongPassword = () =>
  applyDecorators(
    IsString(),
    Length(8, 100),
    Matches(/(?=.*[a-zA-Z])(?=.*[0-9])/, {
      message: 'Password must contain at least one letter and one number.',
    }),
  );

/** Normalise identifiers: trim and lowercase. */
export const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

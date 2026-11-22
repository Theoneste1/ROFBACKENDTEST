/**
 * "Other" Olympiad interest (owner, 2026-11-21; capability olympiadInterestOther). Beside MATHEMATICS, COMPUTING and
 * PHYSICS a person may name another Olympiad in words (e.g. Chemistry). Rules shared by every request that carries
 * interests (student sign-up, teacher and coach applications, PATCH /me, PATCH /admin/users/:id):
 *  - olympiadInterests may be empty only when olympiadInterestOther is given in the same request ("Other" alone counts);
 *  - olympiadInterestOther: 2–100 characters after trimming; null clears it, and only together with at least one subject
 *    in the same request (nobody is left without an interest).
 * The other interest is never a subject: it grants nothing and is not part of Test Management.
 */
import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

export const OTHER_INTEREST_LENGTH = [2, 100] as const;

const hasOther = (o: Record<string, unknown>) => typeof o.olympiadInterestOther === 'string' && o.olympiadInterestOther.trim().length > 0;
const hasSubjects = (o: Record<string, unknown>) => Array.isArray(o.olympiadInterests) && o.olympiadInterests.length > 0;

/** On olympiadInterests (replaces @ArrayNotEmpty): at least one subject, or an "other" interest in the same request. */
export function NonEmptyUnlessOther(options?: ValidationOptions) {
  return (target: object, propertyName: string) => registerDecorator({
    name: 'nonEmptyUnlessOther', target: target.constructor, propertyName, options: {
      message: 'olympiadInterests must name at least one of MATHEMATICS, COMPUTING or PHYSICS, or give olympiadInterestOther.',
      ...options,
    },
    validator: {
      validate: (value: unknown, args: ValidationArguments) =>
        !Array.isArray(value) || value.length > 0 || hasOther(args.object as Record<string, unknown>),
    },
  });
}

/** On olympiadInterestOther: 2–100 characters; null only beside at least one subject. */
export function IsOtherInterest(options?: ValidationOptions) {
  return (target: object, propertyName: string) => registerDecorator({
    name: 'isOtherInterest', target: target.constructor, propertyName, options,
    validator: {
      validate: (value: unknown, args: ValidationArguments) => {
        if (value === null) return hasSubjects(args.object as Record<string, unknown>);
        if (typeof value !== 'string') return false;
        const n = value.trim().length;
        return n >= OTHER_INTEREST_LENGTH[0] && n <= OTHER_INTEREST_LENGTH[1];
      },
      defaultMessage: (args?: ValidationArguments) => (args?.value === null
        ? 'olympiadInterestOther can be cleared only together with at least one of MATHEMATICS, COMPUTING or PHYSICS.'
        : `olympiadInterestOther must be ${OTHER_INTEREST_LENGTH[0]}–${OTHER_INTEREST_LENGTH[1]} characters (another Olympiad, e.g. Chemistry).`),
    },
  });
}

/** The stored form: trimmed text, or null (an empty string or null clears it). Undefined: not given. */
export function storedOtherInterest(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t ? t : null;
}

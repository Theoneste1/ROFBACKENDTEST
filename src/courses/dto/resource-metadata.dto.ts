import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Tags arrive as a JSON array or, from multipart forms, as a comma-separated
 * string / repeated field. Normalised to unique, trimmed, lower-case labels.
 */
export const toTags = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return value;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
};

/** Optional descriptive metadata shared by create and update. */
export class ResourceMetadataDto {
  /** Author(s) of a book, or who prepared the material. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Transform(trim)
  author?: string;

  /** Publisher, or the competition/exam a past paper comes from (e.g. "IMO"). */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Transform(trim)
  source?: string;

  /** Publication year, or the year of the exam. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2200)
  year?: number;

  /** Up to 20 labels, e.g. ["inequalities", "olympiad"]. */
  @IsOptional()
  @Transform(toTags)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  @Matches(/^[\p{L}\p{N}][\p{L}\p{N} _.+-]*$/u, { each: true, message: 'tags may contain letters, digits, spaces and _ . + -' })
  tags?: string[];
}

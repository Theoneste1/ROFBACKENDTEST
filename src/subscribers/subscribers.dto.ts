import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsISO31661Alpha2, IsOptional, IsString, Length, MaxLength,
  ValidateNested,
} from 'class-validator';

import { OlympiadSubject, SubscriberKind, SubscriberSource, SubscriberStatus } from '../generated/prisma/client.js';
import { lower, trim } from '../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../common/pagination.js';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const upperEach = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v)) : value);
/** An empty string from a form counts as "not given". */
const blankToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const bool = ({ value }: { value: unknown }) => (value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : value);

/** POST /public/subscribe. Unknown fields are refused by the global ValidationPipe. */
export class SubscribeDto {
  @Transform(lower)
  @IsEmail({}, { message: 'Enter a valid e-mail address.' })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @Transform(trim)
  @IsString()
  @Length(2, 100, { message: 'Your name must be 2 to 100 characters.' })
  fullName?: string;

  @IsOptional()
  @IsEnum(SubscriberKind)
  kind?: SubscriberKind;

  /** None chosen = every subject. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsEnum(OlympiadSubject, { each: true })
  interests?: OlympiadSubject[];

  @IsOptional()
  @Transform(blankToUndefined)
  @Transform(upper)
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  country?: string;

  /** Honeypot: hidden from people; when filled in the request is accepted silently and nothing is stored. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

/** POST /public/unsubscribe (the frontend page's button). */
export class UnsubscribeDto {
  /** The subscriber id from the link (`s`). Not validated as a UUID so every malformed link gets the same answer. */
  @IsString()
  @Length(1, 100)
  id: string;

  /** The token from the link (`t`). */
  @IsString()
  @Length(1, 200)
  token: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** POST /public/unsubscribe/one-click?s=&t= (RFC 8058; the body "List-Unsubscribe=One-Click" is not read). */
export class OneClickUnsubscribeQueryDto {
  @IsString() @Length(1, 100) s: string;
  @IsString() @Length(1, 200) t: string;
}

export const SUBSCRIBER_SORTS = ['newest', 'oldest', 'name', 'email'] as const;
export type SubscriberSort = (typeof SUBSCRIBER_SORTS)[number];

/** GET /admin/subscribers and /admin/subscribers/export. */
export class ListSubscribersDto extends PaginationQueryDto {
  /** Part of the e-mail or name. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(SubscriberStatus) status?: SubscriberStatus;
  @IsOptional() @IsEnum(OlympiadSubject) interest?: OlympiadSubject;
  @IsOptional() @IsEnum(SubscriberKind) kind?: SubscriberKind;
  @IsOptional() @IsEnum(SubscriberSource) source?: SubscriberSource;
  @IsOptional() @Transform(upper) @IsISO31661Alpha2() country?: string;
  /** newest (default), oldest, name, email. */
  @IsOptional() @IsIn(SUBSCRIBER_SORTS) sort?: SubscriberSort;
}

/** The export takes the list's filters (paging ignored). */
export class ExportSubscribersDto extends ListSubscribersDto {}

/** POST /admin/subscribers: an Administrator adds someone (source ADMIN). */
export class CreateSubscriberDto {
  @Transform(lower)
  @IsEmail({}, { message: 'Enter a valid e-mail address.' })
  @MaxLength(254)
  email: string;

  @IsOptional() @Transform(blankToUndefined) @Transform(trim) @IsString() @Length(2, 100) fullName?: string;
  @IsOptional() @IsEnum(SubscriberKind) kind?: SubscriberKind;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsEnum(OlympiadSubject, { each: true }) interests?: OlympiadSubject[];
  @IsOptional() @Transform(blankToUndefined) @Transform(upper) @IsISO31661Alpha2() country?: string;
}

/**
 * PATCH /admin/subscribers/:id. `status` UNSUBSCRIBED unsubscribes (reason recorded); ACTIVE subscribes again — only
 * with a reason, because the person chose to leave (e.g. "Asked by phone on 3 May").
 */
export class UpdateSubscriberDto {
  /** null clears it. */
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) fullName?: string | null;
  @IsOptional() @IsEnum(SubscriberKind) kind?: SubscriberKind | null;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsEnum(OlympiadSubject, { each: true }) interests?: OlympiadSubject[];
  @IsOptional() @Transform(upper) @IsISO31661Alpha2() country?: string | null;
  @IsOptional() @IsEnum(SubscriberStatus) status?: SubscriberStatus;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;
}

/** POST /admin/subscribers/import?dryRun=true */
export class ImportSubscribersQueryDto {
  /** Check the file and report only; add nobody. */
  @IsOptional() @Transform(bool) @IsBoolean() dryRun?: boolean;
}

export class AudienceDto {
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsEnum(OlympiadSubject, { each: true }) interests?: OlympiadSubject[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsEnum(SubscriberKind, { each: true }) kinds?: SubscriberKind[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @Transform(upperEach) @IsISO31661Alpha2({ each: true }) countries?: string[];
}

/** POST /admin/subscribers/mailings/preview: how many active subscribers an audience reaches. */
export class MailingAudienceDto {
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) audience?: AudienceDto;
}

/** POST /admin/subscribers/mailings/test: the e-mail as subscribers will see it, to the caller only. */
export class TestMailingDto {
  @Transform(trim) @IsString() @Length(3, 150) subject: string;
  @IsString() @Length(10, 20_000) body: string;
}

/** POST /admin/subscribers/mailings */
export class CreateMailingDto extends TestMailingDto {
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) audience?: AudienceDto;

  /** Repeating a request with the same key returns the same mailing (a double click sends once). */
  @IsString() @Length(8, 128) idempotencyKey: string;
}

export class ListMailingsDto extends PaginationQueryDto {}

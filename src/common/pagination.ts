import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const MAX_PAGE_SIZE = 100;

/** Standard `?page=&limit=` query parameters. Extend it for filterable lists. */
export class PaginationQueryDto {
  /** 1-based page number. Default 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** Items per page. Default 20, maximum 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 20;
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function pageArgs(q: PaginationQueryDto) {
  const page  = q.page  ?? 1;
  const limit = Math.min(q.limit ?? 20, MAX_PAGE_SIZE);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

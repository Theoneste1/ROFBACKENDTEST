import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewQueueQueryDto } from './dto/list-submissions.dto.js';
import {
  DEFAULT_QUEUE_STATUSES, DONE_REVIEW_STATUSES, OPEN_REVIEW_STATUSES, reviewQueueCounts, reviewQueueOrder, reviewQueueStatus,
} from './review-queue.js';

describe('review queue (GET /mentor/reviews)', () => {
  it('status: explicit status wins; then the group; without either the original default queue', () => {
    expect(reviewQueueStatus({ status: 'PUBLISHED', group: 'open' })).toBe('PUBLISHED');
    expect(reviewQueueStatus({ group: 'open' })).toEqual({ in: [...OPEN_REVIEW_STATUSES] });
    expect(reviewQueueStatus({ group: 'done' })).toEqual({ in: [...DONE_REVIEW_STATUSES] });
    expect(reviewQueueStatus({ group: 'all' })).toBeUndefined();
    expect(reviewQueueStatus({})).toEqual({ in: [...DEFAULT_QUEUE_STATUSES] });
  });

  it('the groups do not overlap; "done" includes APPROVED and PUBLISHED (the old default queue never showed them)', () => {
    expect(OPEN_REVIEW_STATUSES.filter((s) => DONE_REVIEW_STATUSES.includes(s))).toEqual([]);
    expect(DONE_REVIEW_STATUSES).toEqual(expect.arrayContaining(['APPROVED', 'PUBLISHED']));
  });

  it('every sort ends with the id, so consecutive pages never overlap or skip rows', () => {
    for (const sort of [undefined, 'submitted', 'recent', 'name', 'score'] as const) {
      expect(reviewQueueOrder(sort).at(-1)).toEqual({ id: 'asc' });
    }
    expect(reviewQueueOrder('score')[0]).toEqual({ currentReview: { score: { sort: 'desc', nulls: 'last' } } });
    expect(reviewQueueOrder('name').slice(0, 2)).toEqual([{ student: { firstName: 'asc' } }, { student: { lastName: 'asc' } }]);
  });

  it('counts: open, done and all from per-status totals', () => {
    expect(reviewQueueCounts([
      { status: 'ASSIGNED', count: 2 }, { status: 'IN_REVIEW', count: 1 }, { status: 'APPROVED', count: 5 },
      { status: 'SUBMITTED', count: 7 },   // not a review status of the coach: counted in all only
    ])).toEqual({ open: 3, done: 5, all: 15 });
    expect(reviewQueueCounts([])).toEqual({ open: 0, done: 0, all: 0 });
  });

  it('query validation: known groups and sorts only; search 1–100 characters, trimmed', async () => {
    const errors = async (raw: Record<string, unknown>) =>
      (await validate(plainToInstance(ReviewQueueQueryDto, raw))).map((e) => e.property);
    expect(await errors({ group: 'open', sort: 'score', q: '  ada  ' })).toEqual([]);
    expect(await errors({ group: 'everything' })).toEqual(['group']);
    expect(await errors({ sort: 'random' })).toEqual(['sort']);
    expect(await errors({ q: '   ' })).toEqual(['q']);
    expect(await errors({ q: 'x'.repeat(101) })).toEqual(['q']);
    expect(plainToInstance(ReviewQueueQueryDto, { q: '  ada ' }).q).toBe('ada');
  });
});

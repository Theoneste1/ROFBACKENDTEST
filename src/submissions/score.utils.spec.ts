import { computePercentage, computePointsAwarded, validateScore } from './score.utils.js';

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('validateScore', () => {
  it.each([0, 10, 20])('accepts %i out of 20', (score) => {
    expect(() => validateScore(score, 20)).not.toThrow();
  });

  it.each([
    ['above maximumMarks', 21, 20],
    ['negative', -1, 20],
    ['fractional', 10.5, 20],
    ['NaN', Number.NaN, 20],
    ['with zero maximumMarks', 0, 0],
    ['with negative maximumMarks', 0, -5],
    ['with fractional maximumMarks', 1, 2.5],
  ])('rejects a score %s with INVALID_SCORE', (_label, score, max) => {
    expect(codeOf(() => validateScore(score, max))).toBe('INVALID_SCORE');
  });

  it('uses the context label in the message', () => {
    expect(() => validateScore(-1, 10, 'Bonus')).toThrow('Bonus cannot be negative.');
  });

  it('returns HTTP 400', () => {
    try {
      validateScore(99, 10);
    } catch (err) {
      expect((err as { getStatus(): number }).getStatus()).toBe(400);
    }
  });
});

describe('computePercentage', () => {
  it('computes a percentage', () => {
    expect(computePercentage(15, 20)).toBe(75);
    expect(computePercentage(20, 20)).toBe(100);
    expect(computePercentage(0, 20)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(computePercentage(1, 3)).toBe(33.33);
    expect(computePercentage(2, 3)).toBe(66.67);
  });

  it('returns 0 for a misconfigured maximum', () => {
    expect(computePercentage(5, 0)).toBe(0);
    expect(computePercentage(5, -10)).toBe(0);
    expect(computePercentage(5, 2.5)).toBe(0);
  });
});

describe('computePointsAwarded', () => {
  it('scales assignment points by the score (15/20 of 40 → 30)', () => {
    expect(computePointsAwarded(15, 20, 40)).toBe(30);
  });

  it('awards full and zero points at the extremes', () => {
    expect(computePointsAwarded(20, 20, 40)).toBe(40);
    expect(computePointsAwarded(0, 20, 40)).toBe(0);
  });

  it('rounds to the nearest whole point', () => {
    expect(computePointsAwarded(1, 3, 10)).toBe(3);  // 3.33
    expect(computePointsAwarded(2, 3, 10)).toBe(7);  // 6.67
    expect(computePointsAwarded(1, 4, 10)).toBe(3);  // 2.5 rounds up
  });

  it('returns 0 when maximumMarks or points are not positive', () => {
    expect(computePointsAwarded(10, 0, 40)).toBe(0);
    expect(computePointsAwarded(10, 20, 0)).toBe(0);
    expect(computePointsAwarded(10, 20, -5)).toBe(0);
  });
});

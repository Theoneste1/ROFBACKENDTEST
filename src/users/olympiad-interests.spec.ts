import { OLYMPIAD_SUBJECTS, canonicalInterests, interestLabels } from './olympiad-interests.js';

describe('Olympiad interests (owner decision 8)', () => {
  it('exactly Mathematics, Computing and Physics, in that order', () => {
    expect(OLYMPIAD_SUBJECTS).toEqual(['MATHEMATICS', 'COMPUTING', 'PHYSICS']);
  });

  it('canonicalInterests: fixed order, no duplicates, none for null/undefined', () => {
    expect(canonicalInterests(['PHYSICS', 'MATHEMATICS', 'PHYSICS'])).toEqual(['MATHEMATICS', 'PHYSICS']);
    expect(canonicalInterests(['COMPUTING'])).toEqual(['COMPUTING']);
    expect(canonicalInterests(undefined)).toEqual([]);
    expect(canonicalInterests(null)).toEqual([]);
  });

  it('interestLabels: readable list for CSV exports', () => {
    expect(interestLabels(['PHYSICS', 'COMPUTING', 'MATHEMATICS'])).toBe('Mathematics; Computing; Physics');
    expect(interestLabels([])).toBe('');
  });
});

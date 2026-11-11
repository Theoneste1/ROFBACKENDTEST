import { maskRawRow } from '../directory/school-contacts.js';
import { decisionsDigest, maskChangeValue, maskNormalized, reportDigest } from './sync-report.js';

describe('sync report — masking (C) and digests', () => {
  it('raw rows: contact columns masked (several values, odd formats hidden entirely); other columns kept unless they hold a contact', () => {
    const raw = {
      'School Name': 'EP KARAMA', 'School Code': '220001', Email: 'Head@Example.org; deputy@example.org', Phone: '0788 123 456 / 0722000111',
      'Telephone 2': '0788 12', Village: 'Call 0788999888', Cell: 'N/A',
    };
    const masked = maskRawRow(raw) as Record<string, string>;
    expect(masked).toEqual({
      'School Name': 'EP KARAMA', 'School Code': '220001', Email: 'h•••@e•••.org; d•••@e•••.org', Phone: '+250•••56 / +250•••11',
      'Telephone 2': '•••', Village: 'Call +250•••88', Cell: 'N/A',
    });
    expect(JSON.stringify(masked)).not.toMatch(/example\.org|788123456|0722000111|788999888/);
    expect(raw.Email).toBe('Head@Example.org; deputy@example.org');   // the stored row is untouched
    expect(maskRawRow(null)).toBeNull();
  });

  it('staged values: an ADD_CONTACT value and normalised contacts are masked; other kinds unchanged', () => {
    expect(maskChangeValue('ADD_CONTACT', { type: 'PHONE', value: '+250788123456' })).toEqual({ type: 'PHONE', masked: '+250•••56' });
    expect(maskChangeValue('FILL_EMPTY', 'Gako')).toBe('Gako');
    expect(maskNormalized({ name: 'EP A', contacts: [{ type: 'EMAIL', value: 'a@example.org' }] })).toEqual({ name: 'EP A', contacts: [{ type: 'EMAIL', masked: 'a•••@e•••.org' }] });
  });

  it('digests: independent of order, sensitive to any outcome, value or decision', () => {
    const items = [
      { rowNumber: 2, outcome: 'MATCHED', schoolId: 's', matchedBy: 'CODE', conflictGroup: null },
      { rowNumber: 3, outcome: 'NEW', schoolId: null, matchedBy: null, conflictGroup: null },
    ] as const;
    const changes = [
      { rowNumber: 2, kind: 'FILL_EMPTY', field: 'cell', schoolId: 's', currentValue: null, publishedValue: 'Gako' },
      { rowNumber: 3, kind: 'CREATE_SCHOOL', field: null, schoolId: null, currentValue: null, publishedValue: { name: 'EP B' } },
    ] as const;
    const d = reportDigest(items as any, changes as any);
    expect(reportDigest([...items].reverse() as any, [...changes].reverse() as any)).toBe(d);
    expect(reportDigest(items as any, [{ ...changes[0], publishedValue: 'Other' }, changes[1]] as any)).not.toBe(d);
    expect(reportDigest([{ ...items[0], outcome: 'CONFLICT' }, items[1]] as any, changes as any)).not.toBe(d);
    const pending = changes.map((c) => ({ ...c, decision: 'PENDING' }));
    expect(decisionsDigest(pending)).not.toBe(decisionsDigest([{ ...pending[0], decision: 'APPROVED' }, pending[1]]));
  });
});

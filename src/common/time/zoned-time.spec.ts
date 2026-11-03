import { describeZonedRange, fromZoned, isValidTimeZone, toZoned } from './zoned-time.js';

describe('zoned time', () => {
  it('converts Kigali wall-clock time (UTC+2) to UTC and back', () => {
    const instant = fromZoned('2026-11-20', '14:30', 'Africa/Kigali');
    expect(instant.toISOString()).toBe('2026-11-20T12:30:00.000Z');
    expect(toZoned(instant, 'Africa/Kigali')).toEqual({ date: '2026-11-20', time: '14:30' });
  });

  it('crosses midnight correctly', () => {
    const instant = fromZoned('2026-11-21', '01:00', 'Africa/Kigali');
    expect(instant.toISOString()).toBe('2026-11-20T23:00:00.000Z');
    expect(toZoned(new Date('2026-11-20T23:30:00Z'), 'Africa/Kigali').date).toBe('2026-11-21');
  });

  it('handles zones with daylight saving time', () => {
    expect(fromZoned('2026-07-01', '09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(fromZoned('2026-12-01', '09:00', 'Europe/London').toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });

  it('describes a session time range for messages', () => {
    expect(describeZonedRange(new Date('2026-11-20T12:30:00Z'), new Date('2026-11-20T13:30:00Z'), 'Africa/Kigali'))
      .toBe('Fri, 20 Nov 2026, 14:30–15:30 (Africa/Kigali)');
  });

  it('rejects impossible dates and unknown zones', () => {
    expect(() => fromZoned('2026-02-30', '10:00', 'Africa/Kigali')).toThrow(RangeError);
    expect(isValidTimeZone('Africa/Kigali')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

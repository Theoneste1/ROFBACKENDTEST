/**
 * Calendar dates as the API reads them.
 *
 * Date filters (`from` / `to`) are plain dates interpreted in APP_TIMEZONE
 * (default Africa/Kigali, UTC+2; see src/common/time/zoned-time.ts). A test that
 * builds them from `toISOString()` uses the UTC date instead, which is one day
 * behind Kigali from 00:00 to 02:00 Kigali time (22:00–24:00 UTC) — and then a
 * "today" range misses records made today.
 */
import { DEFAULT_TIME_ZONE, toZoned } from '../../src/common/time/zoned-time.js';

/** The API's time zone, exactly as the application resolves it. */
export const apiTimeZone = () => process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE;

/**
 * "YYYY-MM-DD" in the API's time zone, `offsetDays` calendar days from `now`.
 * The offset is applied to the calendar date, not as 24 hours, so it is also
 * correct in zones with daylight saving time.
 */
export function zonedDate(offsetDays = 0, now: Date = new Date(), timeZone: string = apiTimeZone()): string {
  const [y, m, d] = toZoned(now, timeZone).date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

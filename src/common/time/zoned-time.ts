/**
 * Wall-clock dates and times in the programme's time zone (APP_TIMEZONE,
 * default Africa/Kigali), using only the built-in Intl API.
 *
 * Instants are stored in UTC; these helpers convert to and from the "date +
 * HH:mm" form people schedule and read sessions in.
 */
export const DEFAULT_TIME_ZONE = 'Africa/Kigali';

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(instant: Date, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetAt(ms: number, timeZone: string) {
  const p = parts(new Date(ms), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-20" + "14:30" in the zone → the UTC instant. */
export function fromZoned(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi]   = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Two passes settle the offset across a DST change.
  let ms = wall - offsetAt(wall, timeZone);
  ms = wall - offsetAt(ms, timeZone);
  const result = new Date(ms);
  // Reject impossible dates such as 2026-02-30 (Date.UTC would roll them over).
  if (toZoned(result, timeZone).date !== date) throw new RangeError(`Invalid date ${date}.`);
  return result;
}

/** "Fri, 20 Nov 2026, 14:30 (Africa/Kigali)" for messages. */
export function describeZoned(instant: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(instant);
  return `${day}, ${toZoned(instant, timeZone).time} (${timeZone})`;
}

/** "Fri, 20 Nov 2026, 14:30–15:30 (Africa/Kigali)" for messages. */
export function describeZonedRange(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(start);
  const s = toZoned(start, timeZone);
  const e = toZoned(end, timeZone);
  const endText = e.date === s.date ? e.time : `${e.date} ${e.time}`;
  return `${day}, ${s.time}–${endText} (${timeZone})`;
}

/** A UTC instant → its date ("YYYY-MM-DD") and time ("HH:mm") in the zone. */
export function toZoned(instant: Date, timeZone: string) {
  const p = parts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

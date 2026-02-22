import { describe, it, expect } from 'vitest';
import {
  parseDate,
  dtToIso,
  fmtDt,
  truncate,
  parseRecur,
  nextRecurrence,
} from '../src/date-parser.js';

const DELTA_MS = 60_000; // 60 seconds tolerance for time comparisons

describe('parseDate', () => {
  it('parses +1h as roughly 1 hour from now', () => {
    const result = parseDate('+1h');
    const expected = Date.now() + 1 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +30m as roughly 30 minutes from now', () => {
    const result = parseDate('+30m');
    const expected = Date.now() + 30 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +2h as roughly 2 hours from now', () => {
    const result = parseDate('+2h');
    const expected = Date.now() + 2 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +45m as roughly 45 minutes from now', () => {
    const result = parseDate('+45m');
    const expected = Date.now() + 45 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +1d as roughly 1 day from now', () => {
    const result = parseDate('+1d');
    const expected = Date.now() + 1 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +3d as roughly 3 days from now', () => {
    const result = parseDate('+3d');
    const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +1w as roughly 7 days from now', () => {
    const result = parseDate('+1w');
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(expected, -Math.log10(DELTA_MS));
  });

  it('parses +2w as roughly 14 days from now', () => {
    const result = parseDate('+2w');
    const expected = new Date();
    expected.setDate(expected.getDate() + 14);
    expect(result.getFullYear()).toBe(expected.getFullYear());
    expect(result.getMonth()).toBe(expected.getMonth());
    expect(result.getDate()).toBe(expected.getDate());
  });

  it('parses "today" as today at 23:59', () => {
    const result = parseDate('today');
    const now = new Date();
    expect(result.getFullYear()).toBe(now.getFullYear());
    expect(result.getMonth()).toBe(now.getMonth());
    expect(result.getDate()).toBe(now.getDate());
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
  });

  it('parses "tomorrow" as next day at 09:00', () => {
    const result = parseDate('tomorrow');
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expect(result.getFullYear()).toBe(expected.getFullYear());
    expect(result.getMonth()).toBe(expected.getMonth());
    expect(result.getDate()).toBe(expected.getDate());
    expect(result.getHours()).toBe(9);
    expect(result.getMinutes()).toBe(0);
  });

  it('parses ISO 8601 datetime 2030-06-15T14:30:00', () => {
    const result = parseDate('2030-06-15T14:30:00');
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(5); // June is 0-indexed
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });

  it('parses ISO 8601 date-only 2030-07-04 as midnight', () => {
    const result = parseDate('2030-07-04');
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(6); // July is 0-indexed
    expect(result.getDate()).toBe(4);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
  });

  it('parses ISO 8601 datetime 2030-07-04T15:30:00', () => {
    const result = parseDate('2030-07-04T15:30:00');
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(6);
    expect(result.getDate()).toBe(4);
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });

  it('parses ISO 8601 with space separator 2030-06-15 14:30:00', () => {
    const result = parseDate('2030-06-15 14:30:00');
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });

  it('parses ISO 8601 time without seconds 2030-06-15T14:30', () => {
    const result = parseDate('2030-06-15T14:30');
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });

  it('throws Error for invalid date string', () => {
    expect(() => parseDate('not-a-date-at-all-xyz')).toThrow(Error);
  });
});

describe('dtToIso', () => {
  it('formats a specific date correctly', () => {
    const dt = new Date(2030, 5, 15, 14, 30, 0); // June 15 2030 14:30:00
    expect(dtToIso(dt)).toBe('2030-06-15T14:30:00');
  });

  it('round-trips an ISO string through parseDate and dtToIso', () => {
    const iso = '2030-06-15T14:30:00';
    const result = dtToIso(parseDate(iso));
    expect(result).toBe(iso);
  });
});

describe('fmtDt', () => {
  it('returns empty string for null', () => {
    expect(fmtDt(null)).toBe('');
  });

  it('returns "in ..." for a future time', () => {
    const future = new Date();
    future.setHours(future.getHours() + 2);
    const result = fmtDt(future.toISOString());
    expect(result).toMatch(/^in /);
  });

  it('returns "... ago" for a past time', () => {
    const past = new Date();
    past.setHours(past.getHours() - 2);
    const result = fmtDt(past.toISOString());
    expect(result).toMatch(/ago$/);
  });

  it('returns "in Xd" for a far future time', () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 5);
    const result = fmtDt(farFuture.toISOString());
    expect(result).toMatch(/^in \d+d$/);
  });

  it('returns "Xd ago" for a far past time', () => {
    const farPast = new Date();
    farPast.setDate(farPast.getDate() - 5);
    const result = fmtDt(farPast.toISOString());
    expect(result).toMatch(/^\d+d ago$/);
  });
});

describe('truncate', () => {
  it('returns empty string for null', () => {
    expect(truncate(null, 10)).toBe('');
  });

  it('returns short string unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long string with unicode ellipsis', () => {
    const long = 'this is a very long string that exceeds the max length';
    const result = truncate(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result).toBe('this is a very long\u2026');
  });

  it('returns string at exact max length unchanged', () => {
    const exact = 'exactly ten';
    expect(truncate(exact, exact.length)).toBe(exact);
  });
});

describe('parseRecur', () => {
  it('parses "1d" as daily recurrence', () => {
    expect(parseRecur('1d')).toEqual({ interval: 1, unit: 'd' });
  });

  it('parses "2w" as bi-weekly recurrence', () => {
    expect(parseRecur('2w')).toEqual({ interval: 2, unit: 'w' });
  });

  it('parses "1m" as monthly recurrence', () => {
    expect(parseRecur('1m')).toEqual({ interval: 1, unit: 'm' });
  });

  it('throws Error for invalid recurrence pattern', () => {
    expect(() => parseRecur('invalid')).toThrow(Error);
  });
});

describe('nextRecurrence', () => {
  it('computes daily recurrence from a base date', () => {
    const base = '2030-06-15T10:00:00';
    const result = nextRecurrence(base, { interval: 1, unit: 'd' });
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(16);
    expect(result.getHours()).toBe(10);
    expect(result.getMinutes()).toBe(0);
  });

  it('computes weekly recurrence from a base date', () => {
    const base = '2030-06-15T10:00:00';
    const result = nextRecurrence(base, { interval: 1, unit: 'w' });
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(22);
  });

  it('computes monthly recurrence (30 days) from a base date', () => {
    const base = '2030-06-15T10:00:00';
    const result = nextRecurrence(base, { interval: 1, unit: 'm' });
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(6); // July
    expect(result.getDate()).toBe(15);
  });

  it('uses current date when triggerAt is null', () => {
    const result = nextRecurrence(null, { interval: 1, unit: 'd' });
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expect(result.getTime()).toBeCloseTo(expected.getTime(), -Math.log10(DELTA_MS));
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { installBusinessTimeZone, businessDay, addDays, businessDateParts } from '../../lib/businessTime';
import { dmy } from '../../lib/pdfShared';

// The test machine's own time zone is unknown, so every assertion is about an
// instant whose Sri Lanka day differs from its UTC day (or not), which only
// passes if the code really uses Asia/Colombo.

describe('businessTime', () => {
  beforeAll(() => installBusinessTimeZone());

  it('a date-only value shows the same calendar day on any computer', () => {
    // The reported bug: '2026-10-02' showed as "Oct 1" on a US-time laptop.
    expect(new Date('2026-10-02').toLocaleDateString('en', { day: 'numeric', month: 'short' })).toBe('Oct 2');
  });

  it('formats times in Sri Lanka time by default', () => {
    // 20:00 UTC = 01:30 next day in Colombo.
    const t = new Date('2026-10-01T20:00:00Z');
    expect(t.toLocaleDateString('en', { day: 'numeric', month: 'short' })).toBe('Oct 2');
    expect(t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })).toBe('01:30');
    expect(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(t)).toBe('01:30');
    expect(Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(t)).toBe('01:30');
  });

  it('still honours an explicit time zone', () => {
    const t = new Date('2026-10-01T20:00:00Z');
    expect(t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })).toBe('20:00');
  });

  it('leaves number formatting alone', () => {
    expect((1234567).toLocaleString('en-US')).toBe('1,234,567');
  });

  it('businessDay uses the Sri Lanka day, across the 05:30 boundary', () => {
    expect(businessDay('2026-10-01T18:29:00Z')).toBe('2026-10-01'); // 23:59 Colombo
    expect(businessDay('2026-10-01T18:30:00Z')).toBe('2026-10-02'); // 00:00 Colombo
    expect(businessDay('not a date')).toBe('');
    expect(businessDateParts('2026-10-01T18:30:00Z')).toMatchObject({ year: 2026, month: 10, day: 2, hour: 0, minute: 0 });
  });

  it('addDays is plain calendar arithmetic', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('PDF dates are the Sri Lanka day', () => {
    expect(dmy(new Date('2026-10-01T20:00:00Z'))).toBe('02.10.2026');
  });
});

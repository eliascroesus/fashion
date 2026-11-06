import { describe, expect, it } from 'vitest';
import { blackFriday, inSalePeriod } from '../src/links/sale-periods.ts';

const on = (date: string) => inSalePeriod(new Date(`${date}T12:00:00Z`));

describe('sale periods', () => {
  it('finds Black Friday: the day after the fourth Thursday of November', () => {
    expect(blackFriday(2026).toISOString().slice(0, 10)).toBe('2026-11-27');
    expect(blackFriday(2027).toISOString().slice(0, 10)).toBe('2027-11-26');
    expect(blackFriday(2030).toISOString().slice(0, 10)).toBe('2030-11-29'); // Nov 1 is a Friday: the fifth Friday
  });

  it('covers Black Week to Cyber Monday, Singles’ Day, Christmas–January and the summer sale', () => {
    for (const date of [
      '2026-11-20', // a week before Black Friday
      '2026-11-27',
      '2026-11-30', // Cyber Monday
      '2026-11-11',
      '2026-12-20',
      '2026-12-26',
      '2027-01-15',
      '2027-06-15',
      '2027-07-15',
    ]) {
      expect(on(date), date).toBe(true);
    }
  });

  it('starts and ends on whole UTC days, also when Cyber Monday falls in December', () => {
    const at = (iso: string) => inSalePeriod(new Date(iso));
    expect(at('2026-11-20T00:00:00Z')).toBe(true);
    expect(at('2026-11-19T23:59:59Z')).toBe(false);
    expect(at('2026-11-30T23:59:59Z')).toBe(true);
    expect(at('2026-12-01T00:00:00Z')).toBe(false);
    expect(at('2027-01-15T23:59:59Z')).toBe(true);
    expect(at('2027-01-16T00:00:00Z')).toBe(false);
    // 2030: Black Friday 29 November, Cyber Monday 2 December.
    expect(on('2030-12-02')).toBe(true);
    expect(on('2030-12-03')).toBe(false);
    // 2029: 1 November is a Thursday, Black Friday the 23rd.
    expect(blackFriday(2029).toISOString().slice(0, 10)).toBe('2029-11-23');
    expect(on('2029-11-16')).toBe(true);
    expect(on('2029-11-15')).toBe(false);
  });

  it('is off the rest of the year', () => {
    for (const date of [
      '2026-11-06',
      '2026-11-19',
      '2026-12-01',
      '2026-12-19',
      '2027-01-16',
      '2027-03-10',
      '2027-06-14',
      '2027-07-16',
      '2027-10-01',
    ]) {
      expect(on(date), date).toBe(false);
    }
  });
});

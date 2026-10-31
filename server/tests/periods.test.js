import { describe, it, expect } from 'vitest';
import {
  parseDate as d,
  formatDate as f,
  addPeriod,
  addMonthsClamped,
  periodStartAt,
  nextPeriodStartAfter,
  periodBounds,
} from '../src/lib/dates.js';
import { round2, toApi, sum } from '../src/lib/money.js';
import { formatNumber } from '../src/lib/numbering.js';

describe('TC-BILL-07 period math', () => {
  it('DAILY and WEEKLY steps', () => {
    expect(f(addPeriod(d('2026-10-31'), 'DAILY'))).toBe('2026-11-01');
    expect(f(addPeriod(d('2026-10-31'), 'WEEKLY'))).toBe('2026-11-07');
  });

  it('MONTHLY from 31 Jan clamps to 28 Feb, then back to 31 Mar (no drift)', () => {
    const start = d('2026-01-31');
    expect(f(periodStartAt(start, 'MONTHLY', 1, 1))).toBe('2026-02-28');
    expect(f(periodStartAt(start, 'MONTHLY', 1, 2))).toBe('2026-03-31');
    expect(f(periodStartAt(start, 'MONTHLY', 1, 3))).toBe('2026-04-30');
    expect(f(addMonthsClamped(d('2028-01-31'), 1))).toBe('2028-02-29'); // leap year
  });

  it('YEARLY from 29 Feb 2028 gives 28 Feb 2029', () => {
    expect(f(addPeriod(d('2028-02-29'), 'YEARLY'))).toBe('2029-02-28');
    expect(f(periodStartAt(d('2028-02-29'), 'YEARLY', 1, 4))).toBe('2032-02-29');
  });

  it('interval count: 3 × MONTHLY = quarterly', () => {
    expect(f(periodStartAt(d('2026-01-15'), 'MONTHLY', 3, 1))).toBe('2026-04-15');
  });

  it('period bounds follow TECHNICAL_DESIGN §9.2 example', () => {
    const start = d('2026-01-31');
    const p1 = periodBounds(start, 'MONTHLY', 1, start);
    expect([f(p1.periodStart), f(p1.periodEnd)]).toEqual(['2026-01-31', '2026-02-27']);
    const p2 = periodBounds(start, 'MONTHLY', 1, p1.nextStart);
    expect([f(p2.periodStart), f(p2.periodEnd)]).toEqual(['2026-02-28', '2026-03-30']);
    const p3 = periodBounds(start, 'MONTHLY', 1, p2.nextStart);
    expect([f(p3.periodStart), f(p3.periodEnd)]).toEqual(['2026-03-31', '2026-04-29']);
  });

  it('nextPeriodStartAfter works far from the anchor', () => {
    expect(f(nextPeriodStartAfter(d('2025-03-10'), 'DAILY', 1, d('2026-10-31')))).toBe('2026-11-01');
    expect(f(nextPeriodStartAfter(d('2020-01-31'), 'MONTHLY', 1, d('2026-10-31')))).toBe('2026-11-30');
    expect(f(nextPeriodStartAfter(d('2026-10-31'), 'WEEKLY', 2, d('2026-10-31')))).toBe('2026-11-14');
  });
});

describe('money and numbering helpers', () => {
  it('round2 is half-up', () => {
    expect(toApi(round2('2.345'))).toBe('2.35');
    expect(toApi(round2('2.344'))).toBe('2.34');
    expect(toApi(sum(['0.10', '0.20']))).toBe('0.30');
  });

  it('formats document numbers', () => {
    expect(formatNumber('SUB', 2026, 1)).toBe('SUB/2026/00001');
    expect(formatNumber('INV', 2026, 7001)).toBe('INV/2026/07001');
  });
});

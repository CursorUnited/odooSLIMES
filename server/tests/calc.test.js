import { describe, it, expect } from 'vitest';
import { calculate } from '../src/modules/billing/calc.js';
import { parseDate as d } from '../src/lib/dates.js';

const GST18 = { id: 3, name: 'GST 18%', type: 'PERCENT', rate: '18' };
const crmLine = (quantity, unitPrice = '1559.00') => ({
  productId: 1, variantId: 1, description: 'CRM seats', quantity, unitPrice, taxes: [GST18],
});
const baseFee = { description: 'Monthly plan base fee', unitPrice: '499.00', taxes: [GST18] };
const tenPercentSeats = {
  id: 1, name: '10% for 10+ seats', type: 'PERCENT', value: '10', scope: 'PRODUCT',
  minPurchase: '0', minQuantity: 10, startDate: d('2026-10-01'), endDate: d('2026-12-31'),
  usageLimit: 100, usedCount: 0, isActive: true, productIds: [1], subscriptionIds: [],
};
const run = (over = {}) =>
  calculate({ lines: [crmLine(10)], baseFee, discounts: [tenPercentSeats], subscriptionId: 7, date: d('2026-10-31'), ...over });
const money = (r) => ({
  lines: r.lines.map((l) => [l.subtotal, l.discountAmount, l.taxAmount, l.total].map(String)),
  totals: Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, v.toFixed(2)])),
});

describe('calculate: API.md §7.6 worked example', () => {
  it('10 × CRM (Odoo) on Monthly with "10% for 10+ seats" and GST 18%', () => {
    const r = run();
    expect(money(r)).toEqual({
      lines: [
        ['15590', '1559', '2525.58', '16556.58'],
        ['499', '0', '89.82', '588.82'],
      ],
      totals: { untaxed: '16089.00', discount: '1559.00', tax: '2615.40', total: '17145.40' },
    });
    expect(r.appliedDiscounts.map((a) => [a.id, a.name, a.amount.toFixed(2)])).toEqual([[1, '10% for 10+ seats', '1559.00']]);
    expect(r.lines[0].taxSnapshot).toEqual([{ taxId: 3, name: 'GST 18%', type: 'PERCENT', rate: '18.00', amount: '2525.58' }]);
    expect(r.lines[1].kind).toBe('BASE_FEE');
  });

  it('TC-BILL-01-style: no base fee, no discount → 10 × 1,560 + 18%', () => {
    const r = run({ lines: [crmLine(10, '1560.00')], baseFee: null, discounts: [] });
    expect(money(r).totals).toEqual({ untaxed: '15600.00', discount: '0.00', tax: '2808.00', total: '18408.00' });
  });
});

describe('calculate: rounding (TC-BILL-08)', () => {
  it('3 × 333.33, 7% product discount, 18% tax: half-up per line, totals = sum of rounded lines', () => {
    const r = run({
      lines: [crmLine(3, '333.33')],
      baseFee: null,
      discounts: [{ ...tenPercentSeats, value: '7', minQuantity: 0 }],
    });
    // 999.99 − 70.00 (69.9993) = 929.99; tax 167.40 (167.3982); total 1097.39
    expect(money(r).totals).toEqual({ untaxed: '999.99', discount: '70.00', tax: '167.40', total: '1097.39' });
  });

  it('FIXED tax is rate × quantity', () => {
    const cess = { id: 9, name: 'Cess', type: 'FIXED', rate: '2.50' };
    const r = run({ lines: [{ ...crmLine(4, '100.00'), taxes: [cess] }], baseFee: null, discounts: [] });
    expect(money(r).totals).toEqual({ untaxed: '400.00', discount: '0.00', tax: '10.00', total: '410.00' });
  });
});

describe('calculate: discount eligibility (TC-DISC-01 to 05)', () => {
  it('TC-DISC-03 9 seats: product discount not applied', () => {
    const r = run({ lines: [crmLine(9)] });
    expect(r.totals.discount.toFixed(2)).toBe('0.00');
    expect(r.appliedDiscounts).toEqual([]);
  });

  it('TC-DISC-04 min purchase 20,000 on untaxed 15,600: not applied', () => {
    const r = run({ lines: [crmLine(10, '1560.00')], baseFee: null, discounts: [{ ...tenPercentSeats, minPurchase: '20000' }] });
    expect(r.appliedDiscounts).toEqual([]);
  });

  it('TC-DISC-05 end date before the invoice date: not applied; exhausted and inactive: not applied', () => {
    expect(run({ discounts: [{ ...tenPercentSeats, endDate: d('2026-10-30') }] }).appliedDiscounts).toEqual([]);
    expect(run({ discounts: [{ ...tenPercentSeats, usageLimit: 3, usedCount: 3 }] }).appliedDiscounts).toEqual([]);
    expect(run({ discounts: [{ ...tenPercentSeats, isActive: false }] }).appliedDiscounts).toEqual([]);
    expect(run({ discounts: [{ ...tenPercentSeats, startDate: d('2026-11-01') }] }).appliedDiscounts).toEqual([]);
  });

  it('product scope never touches other products or the base fee', () => {
    const analytics = { productId: 2, variantId: null, description: 'Analytics', quantity: 10, unitPrice: '299.00', taxes: [GST18] };
    const r = run({ lines: [analytics] });
    expect(r.appliedDiscounts).toEqual([]);
  });

  it('TC-DISC-02 FIXED 500 subscription discount is spread over lines before tax', () => {
    const fixed500 = { ...tenPercentSeats, id: 2, name: '₹500 off', type: 'FIXED', value: '500', scope: 'SUBSCRIPTION', minQuantity: 0, productIds: [], subscriptionIds: [7] };
    const r = run({ lines: [crmLine(10)], discounts: [fixed500] });
    // base 15,590 + 499 = 16,089; CRM share 500 × 15590/16089 = 484.49, base fee takes the rest 15.51
    // tax: 15,105.51 × 18% = 2,718.99; 483.49 × 18% = 87.03 → 2,806.02
    expect(money(r).lines.map((l) => l[1])).toEqual(['484.49', '15.51']);
    expect(money(r).totals).toEqual({ untaxed: '16089.00', discount: '500.00', tax: '2806.02', total: '18395.02' });
  });

  it('subscription discount linked to another subscription does not apply; unlinked (global) does', () => {
    const fixed500 = { ...tenPercentSeats, id: 2, type: 'FIXED', value: '500', scope: 'SUBSCRIPTION', minQuantity: 0, productIds: [] };
    expect(run({ discounts: [{ ...fixed500, subscriptionIds: [99] }] }).appliedDiscounts).toEqual([]);
    expect(run({ discounts: [{ ...fixed500, subscriptionIds: [] }] }).appliedDiscounts).toHaveLength(1);
  });

  it('no stacking within a scope: the larger product discount wins; a product and a subscription discount can both apply', () => {
    const fivePercent = { ...tenPercentSeats, id: 3, name: '5%', value: '5' };
    const r1 = run({ discounts: [fivePercent, tenPercentSeats] });
    expect(r1.appliedDiscounts.map((a) => a.id)).toEqual([1]);

    const global2 = { ...tenPercentSeats, id: 4, name: '2% all', value: '2', scope: 'SUBSCRIPTION', minQuantity: 0, productIds: [] };
    const r2 = run({ discounts: [tenPercentSeats, global2] });
    expect(r2.appliedDiscounts.map((a) => a.id).sort()).toEqual([1, 4]);
  });
});

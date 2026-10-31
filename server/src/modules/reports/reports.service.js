// Finance reports (TECHNICAL_DESIGN §12, API.md §4.13). Every number is a SQL aggregate.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { round2, toApi } from '../../lib/money.js';
import { formatDate, parseDate, toIsoLocal, today } from '../../lib/dates.js';

const { sql, empty } = Prisma;

const SUB_STATUSES = ['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'CLOSED'];
const INV_STATUSES = ['DRAFT', 'CONFIRMED', 'PAID', 'CANCELLED'];

/**
 * A business date as a SQL DATE literal. Passing the JS Date itself would send a
 * UTC timestamp that Postgres compares against midnight IST, shifting edges by a day.
 */
const day = (d) => sql`${formatDate(d)}::date`;

/** Default window: first day of the current month to today. */
export function defaultRange({ from, to }) {
  const end = to ?? today();
  const start = from ?? parseDate(`${formatDate(end).slice(0, 7)}-01`);
  return { from: start, to: end };
}

/**
 * Optional plan / customer filters. Subscriptions are joined only when a plan
 * filter needs them, so the unfiltered dashboard stays on single-table scans.
 */
function filtersFor({ planId, customerId }) {
  const plan = planId ? sql`AND s.plan_id = ${planId}` : empty;
  const customer = (alias) => (customerId ? sql`AND ${Prisma.raw(alias)}.customer_id = ${customerId}` : empty);
  return {
    subs: sql`${plan} ${customer('s')}`,
    invJoin: planId ? sql`JOIN subscriptions s ON s.id = i.subscription_id` : empty,
    inv: sql`${plan} ${customer('i')}`,
    payJoin: planId ? sql`JOIN invoices i ON i.id = pa.invoice_id JOIN subscriptions s ON s.id = i.subscription_id` : empty,
    pay: sql`${plan} ${customer('pa')}`,
  };
}

const byStatus = (rows, statuses) => Object.fromEntries(statuses.map((st) => [st, Number(rows.find((r) => r.status === st)?.n ?? 0)]));

// MRR factor per billing period (normalised to a month), divided by interval_count.
const MRR_FACTOR = sql`CASE p.billing_period WHEN 'DAILY' THEN 30 WHEN 'WEEKLY' THEN 52.0 / 12 WHEN 'MONTHLY' THEN 1 ELSE 1.0 / 12 END`;

/** KPIs for the dashboard cards. Dates filter money flows; counts are "now". */
export async function summary(filters) {
  const { from, to } = defaultRange(filters);
  const f = filtersFor(filters);
  const now = day(today());

  const [[money], subsByStatus, invByStatus] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        (SELECT count(*) FROM subscriptions s WHERE s.status = 'ACTIVE' ${f.subs}) AS active_subscriptions,
        (SELECT coalesce(sum(s.recurring_untaxed * ${MRR_FACTOR} / p.interval_count), 0)
           FROM subscriptions s JOIN recurring_plans p ON p.id = s.plan_id
          WHERE s.status = 'ACTIVE' ${f.subs}) AS mrr,
        (SELECT coalesce(sum(pa.amount), 0) FROM payments pa ${f.payJoin}
          WHERE pa.payment_date BETWEEN ${day(from)} AND ${day(to)} ${f.pay}) AS revenue_collected,
        (SELECT coalesce(sum(i.total), 0) FROM invoices i ${f.invJoin}
          WHERE i.status IN ('CONFIRMED', 'PAID') AND i.invoice_date BETWEEN ${day(from)} AND ${day(to)} ${f.inv}) AS invoiced_amount,
        (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM invoices i ${f.invJoin}
          WHERE i.status = 'CONFIRMED' ${f.inv}) AS amount_outstanding,
        (SELECT count(*) FROM invoices i ${f.invJoin}
          WHERE i.status = 'CONFIRMED' AND i.due_date < ${now} AND i.total > i.amount_paid ${f.inv}) AS overdue_count,
        (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM invoices i ${f.invJoin}
          WHERE i.status = 'CONFIRMED' AND i.due_date < ${now} AND i.total > i.amount_paid ${f.inv}) AS overdue_amount`,
    prisma.$queryRaw`SELECT s.status::text AS status, count(*) AS n FROM subscriptions s WHERE true ${f.subs} GROUP BY 1`,
    prisma.$queryRaw`
      SELECT i.status::text AS status, count(*) AS n FROM invoices i ${f.invJoin}
       WHERE i.invoice_date BETWEEN ${day(from)} AND ${day(to)} ${f.inv} GROUP BY 1`,
  ]);

  return {
    from: formatDate(from),
    to: formatDate(to),
    activeSubscriptions: Number(money.active_subscriptions),
    mrr: toApi(round2(money.mrr)),
    revenueCollected: toApi(money.revenue_collected),
    invoicedAmount: toApi(money.invoiced_amount),
    amountOutstanding: toApi(money.amount_outstanding),
    overdueCount: Number(money.overdue_count),
    overdueAmount: toApi(money.overdue_amount),
    subscriptionsByStatus: byStatus(subsByStatus, SUB_STATUSES),
    invoicesByStatus: byStatus(invByStatus, INV_STATUSES),
  };
}

/** Last `months` calendar months ending at `to`: invoiced, collected, new and closed subscriptions. */
export async function revenueByMonth({ to, months = 12, ...filters }) {
  const end = day(to ?? today());
  const f = filtersFor(filters);
  const first = sql`(date_trunc('month', ${end}) - make_interval(months => ${months - 1}::int))::date`;
  const after = sql`(date_trunc('month', ${end}) + interval '1 month')::date`;
  const rows = await prisma.$queryRaw`
    WITH m AS (
      SELECT generate_series(${first}, date_trunc('month', ${end})::date, interval '1 month')::date AS month
    ),
    inv AS (
      SELECT date_trunc('month', i.invoice_date)::date AS month, sum(i.total) AS invoiced FROM invoices i ${f.invJoin}
       WHERE i.status IN ('CONFIRMED', 'PAID') AND i.invoice_date >= ${first} AND i.invoice_date < ${after} ${f.inv}
       GROUP BY 1
    ),
    pay AS (
      SELECT date_trunc('month', pa.payment_date)::date AS month, sum(pa.amount) AS collected FROM payments pa ${f.payJoin}
       WHERE pa.payment_date >= ${first} AND pa.payment_date < ${after} ${f.pay}
       GROUP BY 1
    ),
    opened AS (
      SELECT date_trunc('month', s.start_date)::date AS month, count(*) AS n FROM subscriptions s
       WHERE s.status NOT IN ('DRAFT', 'QUOTATION') AND s.start_date >= ${first} AND s.start_date < ${after} ${f.subs}
       GROUP BY 1
    ),
    closed AS (
      SELECT date_trunc('month', s.closed_at)::date AS month, count(*) AS n FROM subscriptions s
       WHERE s.closed_at >= ${first} AND s.closed_at < ${after} ${f.subs}
       GROUP BY 1
    )
    SELECT to_char(m.month, 'YYYY-MM') AS month,
           coalesce(inv.invoiced, 0) AS invoiced, coalesce(pay.collected, 0) AS collected,
           coalesce(opened.n, 0) AS new_subscriptions, coalesce(closed.n, 0) AS closed_subscriptions
      FROM m
      LEFT JOIN inv ON inv.month = m.month
      LEFT JOIN pay ON pay.month = m.month
      LEFT JOIN opened ON opened.month = m.month
      LEFT JOIN closed ON closed.month = m.month
     ORDER BY m.month`;
  return rows.map((r) => ({
    month: r.month,
    invoiced: toApi(r.invoiced),
    collected: toApi(r.collected),
    newSubscriptions: Number(r.new_subscriptions),
    closedSubscriptions: Number(r.closed_subscriptions),
  }));
}

/** Paginated overdue invoices, most days overdue first (sort=daysOverdue for the reverse). */
export async function overdueInvoices({ page, pageSize, sort, ...filters }) {
  const f = filtersFor(filters);
  const now = day(today());
  const order = sort === 'daysOverdue' ? sql`i.due_date DESC, i.id DESC` : sql`i.due_date ASC, i.id ASC`;
  const where = sql`i.status = 'CONFIRMED' AND i.due_date < ${now} AND i.total > i.amount_paid ${f.inv}`;
  const [[{ total }], rows] = await Promise.all([
    prisma.$queryRaw`SELECT count(*) AS total FROM invoices i ${f.invJoin} WHERE ${where}`,
    prisma.$queryRaw`
      SELECT i.id, i.number, i.due_date, i.total, i.amount_paid, i.sent_at, c.id AS customer_id, c.name AS customer_name,
             (${now} - i.due_date) AS days_overdue
        FROM invoices i ${f.invJoin} JOIN customers c ON c.id = i.customer_id
       WHERE ${where}
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  ]);
  return {
    data: rows.map((r) => ({
      id: r.id,
      number: r.number,
      customer: { id: r.customer_id, name: r.customer_name },
      dueDate: formatDate(r.due_date),
      daysOverdue: Number(r.days_overdue),
      total: toApi(r.total),
      amountDue: toApi(round2(r.total).minus(r.amount_paid)),
      sentAt: toIsoLocal(r.sent_at),
    })),
    page,
    pageSize,
    total: Number(total),
  };
}

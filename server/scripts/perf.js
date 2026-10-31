// Speed check (TEST_PLAN TC-PERF): calls the heavy endpoints N times as Admin and prints
// server time (X-Response-Time) and total round trip, p50 / p95 / max in ms.
// Usage: npm run dev (other terminal), then: node scripts/perf.js [rounds=20]
import 'dotenv/config';

const BASE = process.env.PERF_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1`;
const ROUNDS = Number(process.argv[2] ?? 20);
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@brightloop.test';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@1234';

const ENDPOINTS = [
  '/subscriptions?page=1&pageSize=25',
  '/subscriptions?status=ACTIVE&page=40',
  '/subscriptions?q=lucknow',
  '/invoices?page=1&pageSize=25',
  '/invoices?overdue=true',
  '/invoices?status=CONFIRMED&sort=-total',
  '/payments?page=1',
  '/customers?q=kanpur',
  '/reports/summary',
  '/reports/summary?from=2025-11-01&to=2026-10-31',
  '/reports/revenue-by-month',
  '/reports/overdue-invoices',
];

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function main() {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const rows = [];
  for (const path of ENDPOINTS) {
    const server = [];
    const total = [];
    let count = null;
    for (let i = 0; i < ROUNDS; i += 1) {
      const t0 = performance.now();
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      const body = await res.json();
      total.push(performance.now() - t0);
      server.push(parseFloat(res.headers.get('x-response-time')));
      if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
      count ??= body.total ?? (Array.isArray(body.data) ? body.data.length : 1);
    }
    rows.push({
      endpoint: path,
      rows: count,
      'server p50': pct(server, 50).toFixed(1),
      'server p95': pct(server, 95).toFixed(1),
      'round trip p95': pct(total, 95).toFixed(1),
      max: Math.max(...total).toFixed(1),
    });
  }
  console.table(rows);
  const worst = Math.max(...rows.map((r) => Number(r['round trip p95'])));
  console.log(`Worst p95 round trip: ${worst.toFixed(1)} ms (${worst < 2000 ? 'under' : 'OVER'} the 2 s budget, target 300 ms)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

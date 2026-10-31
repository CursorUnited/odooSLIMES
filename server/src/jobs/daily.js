// Daily job (TECHNICAL_DESIGN §9.6): activate → bill → auto-close, same code as the "Run billing" button.
import cron from 'node-cron';
import { config } from '../config/index.js';
import { today, formatDate } from '../lib/dates.js';
import { runBilling } from '../modules/billing/billing.service.js';

/** Runs one billing pass for today as the system user. Never throws. */
export async function runDaily() {
  try {
    const run = await runBilling({ asOf: today(), userId: null });
    console.log(
      `[daily] billing run #${run.id} for ${run.asOf}: activated ${run.activatedCount}, created ${run.createdCount}, ` +
        `skipped ${run.skippedCount}, failed ${run.failedCount}, closed ${run.closedCount}`,
    );
  } catch (err) {
    console.error(`[daily] billing run for ${formatDate(today())} failed: ${err.code ?? ''} ${err.message}`);
  }
}

/** Schedules the job on BILLING_CRON (default 00:05 IST). */
export function startDailyJob() {
  if (!cron.validate(config.billingCron)) {
    console.warn(`[daily] BILLING_CRON "${config.billingCron}" is not a valid cron expression; daily job disabled`);
    return null;
  }
  console.log(`[daily] billing job scheduled: "${config.billingCron}" (${process.env.TZ})`);
  return cron.schedule(config.billingCron, runDaily, { timezone: process.env.TZ, noOverlap: true });
}

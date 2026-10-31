import { config } from './config/index.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { startDailyJob } from './jobs/daily.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}/api/v1 (TZ=${process.env.TZ})`);
  startDailyJob();
});

async function shutdown(signal) {
  console.log(`[server] ${signal}, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Applies pending migrations to the test database (DATABASE_URL_TEST). Tests truncate tables themselves.
import 'dotenv/config';
import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error('DATABASE_URL_TEST is not set in .env');
  process.exit(1);
}
execSync('npx prisma migrate deploy', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});

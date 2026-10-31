import express from 'express';
import cookieParser from 'cookie-parser';
import { requestId } from './middleware/requestId.js';
import { timing } from './middleware/timing.js';
import { errorHandler, notFoundRoute } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { outboxRouter } from './modules/outbox/outbox.routes.js';

/** Builds the Express app (no listen), so tests can use it with supertest. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'extended');

  // Order matters (TECHNICAL_DESIGN §3.2).
  app.use(requestId);
  app.use(timing);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use('/health', healthRouter); // before auth: must answer 503 (not 500) when the DB is down
  api.use(authenticate);
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/outbox', outboxRouter);
  app.use('/api/v1', api);

  app.use('/api', notFoundRoute);
  app.use(errorHandler);
  return app;
}

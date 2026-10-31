import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();

afterAll(() => prisma.$disconnect());

describe('health and error shape', () => {
  it('GET /api/v1/health reports ok with timing headers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', version: '1.0.0' });
    expect(res.body.time).toMatch(/\+05:30$/);
    expect(res.headers['x-response-time']).toMatch(/ms$/);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('unknown route returns NOT_FOUND in the standard shape', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('bad JSON body returns VALIDATION_FAILED', async () => {
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('body over 1 MB returns 413, not 500', async () => {
    const huge = JSON.stringify({ email: 'a'.repeat(1_100_000) });
    const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(huge);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

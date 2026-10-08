import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from '../helpers/db.js';
import crypto from 'node:crypto';
import { EventEmitter, Readable } from 'node:stream';
import type Database from 'better-sqlite3';

let db: Database.Database;
let cleanup: () => void;

beforeEach(async () => {
  vi.resetModules();
  const testDb = setupTestDb();
  db = testDb.db;
  cleanup = testDb.cleanup;
});

afterEach(() => {
  cleanup();
});

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    company: { name: 'Test Co', description: 'test', services: ['dev'] },
    api: { authToken: 'test-token' },
    stripe: undefined,
    razorpay: undefined,
    ...overrides,
  } as any;
}

function mockRes() {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
    },
    end(body?: string) {
      res._body = body || '';
    },
  } as any;
  return res;
}

function createReadableRequest(body: string, headers: Record<string, string> = {}): any {
  const readable = Readable.from([Buffer.from(body)]);
  (readable as any).headers = headers;
  (readable as any).destroy = readable.destroy.bind(readable);
  return readable;
}

function stripeSign(payload: string, secret: string, timestamp: string): string {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

function razorpaySign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Stripe webhook', () => {
  it('returns 503 when no webhook secret configured', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');
    const req = createReadableRequest('{}');
    const res = mockRes();

    await handleWebhooks(req, res, makeConfig(), '/webhooks/stripe', 'POST');

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body).error).toMatch(/not configured/);
  });

  it('rejects invalid signature with 400', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: {} });
    const req = createReadableRequest(body, {
      'stripe-signature': 't=123,v1=invalidsig',
    });
    const res = mockRes();

    const config = makeConfig({ stripe: { webhookSecret: 'whsec_test' } });
    await handleWebhooks(req, res, config, '/webhooks/stripe', 'POST');

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/Invalid signature/);
  });

  it('accepts valid HMAC signature with 200', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const secret = 'whsec_test123';
    const timestamp = '1234567890';
    const body = JSON.stringify({ id: 'evt_valid', type: 'invoice.paid', data: { object: { id: 'inv_1', amount_paid: 5000 } } });
    const sig = stripeSign(body, secret, timestamp);

    const req = createReadableRequest(body, {
      'stripe-signature': `t=${timestamp},v1=${sig}`,
    });
    const res = mockRes();

    const config = makeConfig({ stripe: { webhookSecret: secret } });
    await handleWebhooks(req, res, config, '/webhooks/stripe', 'POST');

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ received: true });

    // Verify event was stored
    const row = db.prepare("SELECT * FROM webhook_events WHERE source = 'stripe'").get() as any;
    expect(row).toBeTruthy();
    expect(row.provider_event_id).toBe('evt_valid');
  });

  it('deduplicates by event ID', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const secret = 'whsec_dedup';
    const timestamp = '1234567890';
    const body = JSON.stringify({ id: 'evt_dup', type: 'invoice.paid', data: { object: { id: 'inv_1' } } });
    const sig = stripeSign(body, secret, timestamp);

    const config = makeConfig({ stripe: { webhookSecret: secret } });

    // First call
    const req1 = createReadableRequest(body, { 'stripe-signature': `t=${timestamp},v1=${sig}` });
    const res1 = mockRes();
    await handleWebhooks(req1, res1, config, '/webhooks/stripe', 'POST');
    expect(res1._status).toBe(200);
    expect(JSON.parse(res1._body).duplicate).toBeUndefined();

    // Second call (duplicate)
    const req2 = createReadableRequest(body, { 'stripe-signature': `t=${timestamp},v1=${sig}` });
    const res2 = mockRes();
    await handleWebhooks(req2, res2, config, '/webhooks/stripe', 'POST');
    expect(res2._status).toBe(200);
    expect(JSON.parse(res2._body).duplicate).toBe(true);

    // Only one event stored
    const count = (db.prepare("SELECT COUNT(*) as c FROM webhook_events WHERE source = 'stripe'").get() as any).c;
    expect(count).toBe(1);
  });
});

describe('Razorpay webhook', () => {
  it('returns 503 when no webhook secret configured', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');
    const req = createReadableRequest('{}');
    const res = mockRes();

    await handleWebhooks(req, res, makeConfig(), '/webhooks/razorpay', 'POST');

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body).error).toMatch(/not configured/);
  });

  it('uses constant-time comparison and rejects bad signature', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const body = JSON.stringify({ event: 'payment_link.paid', payload: {} });
    const req = createReadableRequest(body, {
      'x-razorpay-signature': 'badbadbadbad',
    });
    const res = mockRes();

    const config = makeConfig({ razorpay: { webhookSecret: 'rp_secret' } });
    await handleWebhooks(req, res, config, '/webhooks/razorpay', 'POST');

    expect(res._status).toBe(400);
  });

  it('accepts valid razorpay signature', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const secret = 'rp_secret_valid';
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1' } } } });
    const sig = razorpaySign(body, secret);

    const req = createReadableRequest(body, {
      'x-razorpay-signature': sig,
    });
    const res = mockRes();

    const config = makeConfig({ razorpay: { webhookSecret: secret } });
    await handleWebhooks(req, res, config, '/webhooks/razorpay', 'POST');

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ received: true });
  });
});

describe('Generic webhook', () => {
  it('requires auth', async () => {
    const { handleWebhooks } = await import('../../src/api/routes/webhooks.js');

    const body = JSON.stringify({ source: 'test', type: 'ping' });
    const req = createReadableRequest(body, {});
    const res = mockRes();

    // No auth token header → should fail
    const config = makeConfig({ api: { authToken: 'my-secret' } });
    await handleWebhooks(req, res, config, '/webhooks/generic', 'POST');

    expect(res._status).toBe(401);
  });
});

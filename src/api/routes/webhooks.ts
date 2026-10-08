import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../../config/schema.js';
import { authenticate, sendJson, parseRawBody, parseBody } from '../middleware.js';
import { getSqlite } from '../../db/index.js';
import { getLogger } from '../../utils/logger.js';
import crypto from 'node:crypto';

const log = getLogger('webhooks');

export async function handleWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig,
  pathname: string,
  method: string
): Promise<void> {
  // WhatsApp verification uses GET
  if (pathname === '/webhooks/whatsapp') {
    const { handleWhatsApp } = await import('./whatsapp.js');
    await handleWhatsApp(req, res, config, pathname, method);
    return;
  }

  if (method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405);
    return;
  }

  if (pathname === '/webhooks/stripe') {
    await handleStripeWebhook(req, res, config);
  } else if (pathname === '/webhooks/razorpay') {
    await handleRazorpayWebhook(req, res, config);
  } else if (pathname === '/webhooks/generic') {
    await handleGenericWebhook(req, res, config);
  } else {
    sendJson(res, { error: 'Unknown webhook endpoint' }, 404);
  }
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function handleStripeWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  // Require webhook secret — refuse unsigned webhooks
  const webhookSecret = config.stripe?.webhookSecret;
  if (!webhookSecret) {
    sendJson(res, { error: 'Stripe webhook secret not configured' }, 503);
    return;
  }

  const rawBody = await parseRawBody(req);

  const sigHeader = req.headers['stripe-signature'] as string;
  if (!sigHeader) {
    sendJson(res, { error: 'Missing stripe-signature header' }, 400);
    return;
  }

  const elements = sigHeader.split(',');
  const timestamp = elements.find(e => e.startsWith('t='))?.split('=')[1];
  const signature = elements.find(e => e.startsWith('v1='))?.split('=')[1];

  if (!timestamp || !signature) {
    sendJson(res, { error: 'Invalid signature format' }, 400);
    return;
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload)
    .digest('hex');

  if (!timingSafeCompare(signature, expectedSig)) {
    sendJson(res, { error: 'Invalid signature' }, 400);
    return;
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    sendJson(res, { error: 'Invalid JSON' }, 400);
    return;
  }

  const db = getSqlite();

  // Idempotency: check for duplicate event by provider_event_id
  const providerEventId = event.id || null;
  if (providerEventId) {
    const existing = db.prepare(
      "SELECT id FROM webhook_events WHERE source = 'stripe' AND provider_event_id = ?"
    ).get(providerEventId) as { id: number } | undefined;

    if (existing) {
      log.info({ providerEventId }, 'Duplicate Stripe webhook event, skipping');
      sendJson(res, { received: true, duplicate: true });
      return;
    }
  }

  // Store webhook event
  const result = db.prepare(`
    INSERT INTO webhook_events (source, event_type, payload, provider_event_id, status, created_at)
    VALUES ('stripe', ?, ?, ?, 'pending', datetime('now'))
  `).run(event.type, rawBody, providerEventId);

  const eventId = Number(result.lastInsertRowid);

  // Process known event types
  try {
    switch (event.type) {
      case 'invoice.paid': {
        const invoice = event.data?.object;
        if (invoice?.id) {
          db.prepare(`
            UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
            WHERE stripe_invoice_id = ?
          `).run(invoice.id);

          // Record revenue transaction
          if (invoice.amount_paid) {
            db.prepare(`
              INSERT INTO transactions (type, category, amount, description, stripe_invoice_id, created_at)
              VALUES ('revenue', 'invoice_payment', ?, ?, ?, datetime('now'))
            `).run(invoice.amount_paid / 100, `Stripe payment: ${invoice.id}`, invoice.id);
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data?.object;
        if (invoice?.id) {
          db.prepare(`
            UPDATE invoices SET status = 'overdue', updated_at = datetime('now')
            WHERE stripe_invoice_id = ?
          `).run(invoice.id);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data?.object;
        if (sub?.id) {
          db.prepare(`
            UPDATE subscriptions SET status = ?, updated_at = datetime('now')
            WHERE stripe_subscription_id = ?
          `).run(sub.status === 'active' ? 'active' : sub.status, sub.id);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data?.object;
        if (sub?.id) {
          db.prepare(`
            UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now')
            WHERE stripe_subscription_id = ?
          `).run(sub.id);
        }
        break;
      }
    }

    db.prepare(`
      UPDATE webhook_events SET status = 'processed', processed_by = 'api', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId);

    log.info({ eventType: event.type, eventId }, 'Stripe webhook processed');
  } catch (err: any) {
    db.prepare(`
      UPDATE webhook_events SET status = 'failed', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId);
    log.error({ err, eventType: event.type }, 'Failed to process Stripe webhook');
  }

  sendJson(res, { received: true });
}

async function handleRazorpayWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  // Require webhook secret — refuse unsigned webhooks
  const webhookSecret = config.razorpay?.webhookSecret;
  if (!webhookSecret) {
    sendJson(res, { error: 'Razorpay webhook secret not configured' }, 503);
    return;
  }

  const rawBody = await parseRawBody(req);

  const signature = req.headers['x-razorpay-signature'] as string;
  if (!signature) {
    sendJson(res, { error: 'Missing x-razorpay-signature header' }, 400);
    return;
  }

  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (!timingSafeCompare(signature, expectedSig)) {
    sendJson(res, { error: 'Invalid signature' }, 400);
    return;
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    sendJson(res, { error: 'Invalid JSON' }, 400);
    return;
  }

  const db = getSqlite();
  const eventType = event.event || 'unknown';

  // Idempotency: check for duplicate event
  const providerEventId = event.account_id && event.event
    ? `${event.account_id}_${event.event}_${event.payload?.payment?.entity?.id || event.payload?.payment_link?.entity?.id || ''}`
    : null;

  if (providerEventId) {
    const existing = db.prepare(
      "SELECT id FROM webhook_events WHERE source = 'razorpay' AND provider_event_id = ?"
    ).get(providerEventId) as { id: number } | undefined;

    if (existing) {
      log.info({ providerEventId }, 'Duplicate Razorpay webhook event, skipping');
      sendJson(res, { received: true, duplicate: true });
      return;
    }
  }

  // Store webhook event
  const result = db.prepare(`
    INSERT INTO webhook_events (source, event_type, payload, provider_event_id, status, created_at)
    VALUES ('razorpay', ?, ?, ?, 'pending', datetime('now'))
  `).run(eventType, rawBody, providerEventId);

  const eventId = Number(result.lastInsertRowid);

  try {
    const entity = event.payload?.payment_link?.entity;
    const paymentEntity = event.payload?.payment?.entity;

    switch (eventType) {
      case 'payment_link.paid': {
        if (entity?.id) {
          db.prepare(`
            UPDATE payment_links SET status = 'paid', paid_at = datetime('now'),
              razorpay_payment_id = ?
            WHERE razorpay_link_id = ?
          `).run(paymentEntity?.id || null, entity.id);

          // Record revenue
          const link = db.prepare('SELECT * FROM payment_links WHERE razorpay_link_id = ?').get(entity.id) as any;
          if (link) {
            db.prepare(`
              INSERT INTO transactions (type, category, amount, currency, description, created_at)
              VALUES ('revenue', 'payment_link', ?, ?, ?, datetime('now'))
            `).run(link.amount, link.currency, `Razorpay payment: ${entity.id}`);

            if (link.invoice_id) {
              db.prepare(`
                UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
              `).run(link.invoice_id);
            }
          }
        }
        break;
      }
      case 'payment_link.expired': {
        if (entity?.id) {
          db.prepare("UPDATE payment_links SET status = 'expired' WHERE razorpay_link_id = ?").run(entity.id);
        }
        break;
      }
      case 'payment_link.cancelled': {
        if (entity?.id) {
          db.prepare("UPDATE payment_links SET status = 'cancelled' WHERE razorpay_link_id = ?").run(entity.id);
        }
        break;
      }
    }

    db.prepare(`
      UPDATE webhook_events SET status = 'processed', processed_by = 'api', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId);

    log.info({ eventType, eventId }, 'Razorpay webhook processed');
  } catch (err: any) {
    db.prepare(`
      UPDATE webhook_events SET status = 'failed', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId);
    log.error({ err, eventType }, 'Failed to process Razorpay webhook');
  }

  sendJson(res, { received: true });
}

async function handleGenericWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  // Generic webhooks require API authentication
  if (!authenticate(req, res, config)) return;

  const body = await parseBody(req);
  const db = getSqlite();

  const source = body.source || 'unknown';
  const eventType = body.event_type || body.type || 'generic';

  db.prepare(`
    INSERT INTO webhook_events (source, event_type, payload, status, created_at)
    VALUES (?, ?, ?, 'pending', datetime('now'))
  `).run(source, eventType, JSON.stringify(body));

  log.info({ source, eventType }, 'Generic webhook received');
  sendJson(res, { received: true }, 201);
}

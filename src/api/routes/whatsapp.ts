import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../../config/schema.js';
import { sendJson, parseBody } from '../middleware.js';
import { getSqlite } from '../../db/index.js';
import { getLogger } from '../../utils/logger.js';
import { URL } from 'node:url';

const log = getLogger('api:whatsapp');

export async function handleWhatsApp(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig,
  pathname: string,
  method: string
): Promise<void> {
  if (method === 'GET') {
    // Webhook verification (challenge-response)
    handleVerification(req, res, config);
  } else if (method === 'POST') {
    await handleIncomingMessage(req, res, config);
  } else {
    sendJson(res, { error: 'Method not allowed' }, 405);
  }
}

function handleVerification(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const verifyToken = config.whatsapp?.webhookVerifyToken;

  if (mode === 'subscribe' && token === verifyToken && verifyToken) {
    log.info('WhatsApp webhook verified');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge || '');
  } else {
    log.warn('WhatsApp webhook verification failed');
    sendJson(res, { error: 'Verification failed' }, 403);
  }
}

async function handleIncomingMessage(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  const body = await parseBody(req);
  const db = getSqlite();

  // Store raw webhook event
  db.prepare(`
    INSERT INTO webhook_events (source, event_type, payload, status, created_at)
    VALUES ('whatsapp', 'incoming', ?, 'pending', datetime('now'))
  `).run(JSON.stringify(body));

  // Provider-agnostic: extract phone and message from common payload structures
  const { phone, name, message } = extractMessageData(body);

  if (phone) {
    // Find or create lead by phone
    const existingLead = db.prepare(
      'SELECT id FROM leads WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    ).get(phone) as any;

    if (existingLead) {
      // Log activity on existing lead
      db.prepare(`
        INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, body, metadata, created_by)
        VALUES (?, 'whatsapp', 'inbound', 'whatsapp', 'WhatsApp message', ?, ?, 'whatsapp_webhook')
      `).run(existingLead.id, message || null, JSON.stringify({ phone, name }));

      db.prepare(`
        UPDATE leads SET last_contacted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(existingLead.id);

      log.info({ leadId: existingLead.id, phone }, 'WhatsApp message logged for existing lead');
    } else {
      // Create new lead
      const result = db.prepare(`
        INSERT INTO leads (name, phone, source, channel, stage, status, notes, created_at, updated_at)
        VALUES (?, ?, 'inbound', 'whatsapp', 'enquiry', 'new', ?, datetime('now'), datetime('now'))
      `).run(name || phone, phone, message || null);

      const leadId = Number(result.lastInsertRowid);

      db.prepare(`
        INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, body, metadata, created_by)
        VALUES (?, 'whatsapp', 'inbound', 'whatsapp', 'New lead via WhatsApp', ?, ?, 'whatsapp_webhook')
      `).run(leadId, message || null, JSON.stringify({ phone, name }));

      log.info({ leadId, phone }, 'New lead created from WhatsApp message');
    }
  }

  // Acknowledge receipt
  sendJson(res, { received: true });
}

function extractMessageData(body: any): { phone: string | null; name: string | null; message: string | null } {
  // Meta/WhatsApp Business API format
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msg = value?.messages?.[0];
  const contact = value?.contacts?.[0];

  if (msg) {
    return {
      phone: msg.from || null,
      name: contact?.profile?.name || null,
      message: msg.text?.body || msg.type || null,
    };
  }

  // Generic/Twilio-like format
  if (body.From || body.from || body.phone) {
    return {
      phone: body.From || body.from || body.phone || null,
      name: body.ProfileName || body.name || null,
      message: body.Body || body.body || body.message || null,
    };
  }

  // Direct format
  return {
    phone: body.phone || body.sender || null,
    name: body.name || body.sender_name || null,
    message: body.message || body.text || body.body || null,
  };
}

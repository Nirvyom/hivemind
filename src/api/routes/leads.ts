import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../../config/schema.js';
import { sendJson, parseBody } from '../middleware.js';
import { getSqlite } from '../../db/index.js';
import { getLogger } from '../../utils/logger.js';

const log = getLogger('api:leads');

export async function handleLeads(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig,
  pathname: string,
  method: string
): Promise<void> {
  if (pathname === '/api/leads/capture' && method === 'POST') {
    await handleLeadCapture(req, res, config);
  } else if (pathname === '/api/leads/import' && method === 'POST') {
    await handleLeadImport(req, res, config);
  } else {
    sendJson(res, { error: 'Not found' }, 404);
  }
}

async function handleLeadCapture(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  const body = await parseBody(req);

  if (!body.name) {
    sendJson(res, { error: 'name is required' }, 400);
    return;
  }

  const db = getSqlite();

  const result = db.prepare(`
    INSERT INTO leads (name, email, company, phone, source, channel, requirements, budget_range, urgency, notes, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enquiry', 'new', datetime('now'), datetime('now'))
  `).run(
    body.name,
    body.email || null,
    body.company || null,
    body.phone || null,
    body.source || 'inbound',
    body.channel || 'form',
    body.requirements || null,
    body.budgetRange || body.budget_range || null,
    body.urgency || 'normal',
    body.notes || null
  );

  const leadId = Number(result.lastInsertRowid);

  // Log activity
  db.prepare(`
    INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, metadata, created_by)
    VALUES (?, 'note', 'inbound', ?, 'Lead captured', ?, 'api')
  `).run(leadId, body.channel || 'form', JSON.stringify({ source: body.source, channel: body.channel }));

  log.info({ leadId, name: body.name }, 'Lead captured via API');

  sendJson(res, {
    id: leadId,
    name: body.name,
    stage: 'enquiry',
    status: 'new',
  }, 201);
}

async function handleLeadImport(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): Promise<void> {
  const body = await parseBody(req);

  if (!Array.isArray(body.leads) || body.leads.length === 0) {
    sendJson(res, { error: 'leads array is required' }, 400);
    return;
  }

  const db = getSqlite();
  const stmt = db.prepare(`
    INSERT INTO leads (name, email, company, phone, source, channel, requirements, budget_range, urgency, notes, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enquiry', 'new', datetime('now'), datetime('now'))
  `);

  let imported = 0;
  const errors: string[] = [];

  const insertMany = db.transaction((leads: any[]) => {
    for (const lead of leads) {
      if (!lead.name) {
        errors.push(`Skipped lead without name`);
        continue;
      }
      stmt.run(
        lead.name,
        lead.email || null,
        lead.company || null,
        lead.phone || null,
        lead.source || 'import',
        lead.channel || 'manual',
        lead.requirements || null,
        lead.budgetRange || lead.budget_range || null,
        lead.urgency || 'normal',
        lead.notes || null
      );
      imported++;
    }
  });

  insertMany(body.leads);

  log.info({ imported, errors: errors.length }, 'Leads imported via API');

  sendJson(res, { imported, errors, total: body.leads.length }, 201);
}

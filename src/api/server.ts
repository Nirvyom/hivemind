import http from 'node:http';
import { URL } from 'node:url';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import { authenticate, sendJson, parseBody, getUrlParams } from './middleware.js';
import { handleWebhooks } from './routes/webhooks.js';
import { handleKpi } from './routes/kpi.js';
import { handleClients } from './routes/clients.js';
import { handleLeads } from './routes/leads.js';

const log = getLogger('api');

export function createApiServer(config: HivemindConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // CORS headers — restrict to localhost origins
    const origin = req.headers.origin;
    const allowedOrigin = origin?.startsWith('http://localhost') ? origin : '';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Webhook routes (no auth required — they use their own verification)
      if (pathname.startsWith('/webhooks/')) {
        await handleWebhooks(req, res, config, pathname, method);
        return;
      }

      // Support ticket creation endpoint
      if (pathname === '/api/support/tickets' && method === 'POST') {
        if (!authenticate(req, res, config)) return;
        const body = await parseBody(req);
        const { getSqlite } = await import('../db/index.js');
        const db = getSqlite();

        const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
        const result = db.prepare(`
          INSERT INTO support_tickets (ticket_number, client_id, subject, body, category, priority, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
        `).run(
          ticketNumber,
          body.clientId || null,
          body.subject || 'No subject',
          body.body || '',
          body.category || null,
          body.priority || 3
        );

        sendJson(res, {
          id: Number(result.lastInsertRowid),
          ticketNumber,
          status: 'open',
        }, 201);
        return;
      }

      // All other API routes require auth
      if (pathname.startsWith('/api/')) {
        if (!authenticate(req, res, config)) return;

        // Lead capture & import
        if (pathname.startsWith('/api/leads/')) {
          await handleLeads(req, res, config, pathname, method);
          return;
        }

        if (pathname.startsWith('/api/kpi')) {
          await handleKpi(req, res, config, pathname);
          return;
        }

        if (pathname.startsWith('/api/clients/')) {
          await handleClients(req, res, config, pathname);
          return;
        }

        // Pipeline view
        if (pathname === '/api/pipeline' && method === 'GET') {
          await handlePipeline(req, res);
          return;
        }

        // Approvals
        if (pathname === '/api/approvals' && method === 'GET') {
          await handleGetApprovals(req, res);
          return;
        }

        const approveParams = getUrlParams(pathname, '/api/approvals/:id/approve');
        if (approveParams && method === 'POST') {
          await handleApprovalAction(req, res, config, parseInt(approveParams.id, 10), true);
          return;
        }

        const rejectParams = getUrlParams(pathname, '/api/approvals/:id/reject');
        if (rejectParams && method === 'POST') {
          await handleApprovalAction(req, res, config, parseInt(rejectParams.id, 10), false);
          return;
        }

        // Performance / KPIs
        if (pathname === '/api/performance' && method === 'GET') {
          await handlePerformance(req, res);
          return;
        }

        // Exceptions
        if (pathname === '/api/exceptions' && method === 'GET') {
          await handleExceptions(req, res);
          return;
        }

        // Latest briefing
        if (pathname === '/api/briefing/latest' && method === 'GET') {
          await handleLatestBriefing(req, res);
          return;
        }

        sendJson(res, { error: 'Not found' }, 404);
        return;
      }

      // Health check
      if (pathname === '/health') {
        sendJson(res, { status: 'ok', uptime: process.uptime() });
        return;
      }

      sendJson(res, { error: 'Not found' }, 404);
    } catch (err: any) {
      log.error({ err, pathname, method }, 'API error');
      sendJson(res, { error: 'Internal server error' }, 500);
    }
  });

  return server;
}

async function handlePipeline(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getSqlite } = await import('../db/index.js');
  const db = getSqlite();

  const stages = ['enquiry', 'qualified', 'responded', 'proposal_sent', 'negotiating', 'won', 'lost', 'dormant'];
  const pipeline: Record<string, any> = {};

  for (const stage of stages) {
    const leads = db.prepare(
      'SELECT id, name, company, email, phone, urgency, service_fit_score, budget_range, next_action, next_action_due, created_at FROM leads WHERE stage = ? ORDER BY created_at DESC'
    ).all(stage) as any[];

    pipeline[stage] = { count: leads.length, leads };
  }

  sendJson(res, pipeline);
}

async function handleGetApprovals(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getPendingApprovals } = await import('../services/approval.js');
  const approvals = getPendingApprovals();
  sendJson(res, approvals);
}

async function handleApprovalAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HivemindConfig,
  approvalId: number,
  approved: boolean
): Promise<void> {
  const body = await parseBody(req);
  const { processApprovalResponse } = await import('../services/approval.js');

  try {
    await processApprovalResponse(approvalId, approved, body.reviewedBy || 'api', body.note || null, config);
    sendJson(res, { id: approvalId, status: approved ? 'approved' : 'rejected' });
  } catch (err: any) {
    sendJson(res, { error: err.message }, 400);
  }
}

async function handlePerformance(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getSqlite } = await import('../db/index.js');
  const db = getSqlite();

  const avgResponseTime = (db.prepare(`
    SELECT AVG(CAST((julianday(oa.created_at) - julianday(l.created_at)) * 24 AS REAL)) as avg_hours
    FROM leads l
    JOIN opportunity_activities oa ON oa.lead_id = l.id AND oa.direction = 'outbound'
    WHERE l.created_at >= datetime('now', '-30 days')
  `).get() as any)?.avg_hours || 0;

  const conversionRate = (() => {
    const total = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE created_at >= datetime('now', '-30 days')").get() as any).c;
    const won = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE stage = 'won' AND won_at >= datetime('now', '-30 days')").get() as any).c;
    return total > 0 ? (won / total * 100) : 0;
  })();

  const revenue30d = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue' AND created_at >= datetime('now', '-30 days')"
  ).get() as any).total;

  const proposalsSent = (db.prepare(
    "SELECT COUNT(*) as c FROM opportunity_activities WHERE activity_type = 'proposal_sent' AND created_at >= datetime('now', '-30 days')"
  ).get() as any).c;

  sendJson(res, {
    avgResponseTimeHours: Math.round(avgResponseTime * 10) / 10,
    conversionRate: Math.round(conversionRate * 10) / 10,
    revenue30d,
    proposalsSent,
  });
}

async function handleExceptions(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getSqlite } = await import('../db/index.js');
  const db = getSqlite();

  const staleLeads = db.prepare(`
    SELECT id, name, company, stage, next_action_due FROM leads
    WHERE next_action_due IS NOT NULL AND next_action_due < datetime('now')
      AND stage NOT IN ('won', 'lost', 'dormant')
    ORDER BY next_action_due ASC LIMIT 20
  `).all();

  const overduePayments = db.prepare(`
    SELECT pl.id, pl.amount, pl.currency, pl.status, pl.created_at, l.name as lead_name
    FROM payment_links pl
    LEFT JOIN leads l ON l.id = pl.lead_id
    WHERE pl.status IN ('created', 'sent') AND pl.created_at < datetime('now', '-7 days')
  `).all();

  sendJson(res, { staleLeads, overduePayments });
}

async function handleLatestBriefing(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getSqlite } = await import('../db/index.js');
  const db = getSqlite();

  const briefing = db.prepare(
    'SELECT * FROM daily_briefings ORDER BY date DESC LIMIT 1'
  ).get() as any;

  if (!briefing) {
    sendJson(res, { error: 'No briefing available' }, 404);
    return;
  }

  sendJson(res, {
    date: briefing.date,
    pipelineSummary: JSON.parse(briefing.pipeline_summary),
    exceptions: JSON.parse(briefing.exceptions),
    recommendations: JSON.parse(briefing.recommendations),
    metrics: JSON.parse(briefing.metrics),
    deliveredVia: briefing.delivered_via,
    deliveredAt: briefing.delivered_at,
  });
}

export function startApiServer(config: HivemindConfig): http.Server | null {
  if (!config.api?.enabled) {
    log.info('API server disabled in config');
    return null;
  }

  const port = config.api.port || 9474;
  const server = createApiServer(config);

  server.listen(port, '127.0.0.1', () => {
    log.info({ port, host: '127.0.0.1' }, 'API server listening');
  });

  return server;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../../config/schema.js';
import { sendJson, getUrlParams } from '../middleware.js';
import { getSqlite } from '../../db/index.js';

export async function handleClients(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: HivemindConfig,
  pathname: string
): Promise<void> {
  const db = getSqlite();

  // GET /api/clients/:id/invoices
  let params = getUrlParams(pathname, '/api/clients/:id/invoices');
  if (params) {
    const clientId = parseInt(params.id, 10);
    const invoices = db.prepare(`
      SELECT id, invoice_number, amount, total_amount, currency, status, due_date, paid_at, created_at
      FROM invoices WHERE client_id = ? ORDER BY created_at DESC
    `).all(clientId) as any[];

    sendJson(res, { clientId, invoices });
    return;
  }

  // GET /api/clients/:id/contracts
  params = getUrlParams(pathname, '/api/clients/:id/contracts');
  if (params) {
    const clientId = parseInt(params.id, 10);
    const contracts = db.prepare(`
      SELECT id, title, type, value, currency, status, effective_date, expiry_date, signed_at, created_at
      FROM contracts WHERE client_id = ? ORDER BY created_at DESC
    `).all(clientId) as any[];

    sendJson(res, { clientId, contracts });
    return;
  }

  // GET /api/clients/:id/status
  params = getUrlParams(pathname, '/api/clients/:id/status');
  if (params) {
    const clientId = parseInt(params.id, 10);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;

    if (!client) {
      sendJson(res, { error: 'Client not found' }, 404);
      return;
    }

    const activeSubscriptions = db.prepare(`
      SELECT product_name, tier_name, amount, billing_cycle, status, next_billing_date
      FROM subscriptions WHERE client_id = ? AND status = 'active'
    `).all(clientId) as any[];

    const openTickets = (db.prepare(`
      SELECT COUNT(*) as c FROM support_tickets
      WHERE client_id = ? AND status IN ('open', 'in_progress', 'waiting')
    `).get(clientId) as any).c;

    const totalPaid = (db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as t FROM invoices
      WHERE client_id = ? AND status = 'paid'
    `).get(clientId) as any).t;

    sendJson(res, {
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        company: client.company,
        status: client.status,
        signedAt: client.signed_at,
      },
      subscriptions: activeSubscriptions,
      openTickets,
      totalPaid,
    });
    return;
  }

  sendJson(res, { error: 'Unknown client endpoint' }, 404);
}

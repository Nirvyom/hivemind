import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../../config/schema.js';
import { sendJson } from '../middleware.js';
import { getSqlite } from '../../db/index.js';

export async function handleKpi(
  _req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig,
  pathname: string
): Promise<void> {
  const db = getSqlite();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartStr = monthStart.toISOString();

  if (pathname === '/api/kpi') {
    const totalRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue'"
    ).get() as any).t;

    const totalExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense'"
    ).get() as any).t;

    const monthlyRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue' AND created_at >= ?"
    ).get(monthStartStr) as any).t;

    const monthlyExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense' AND created_at >= ?"
    ).get(monthStartStr) as any).t;

    const mrr = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'"
    ).get() as any).t;

    const leadCount = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;
    const clientCount = (db.prepare('SELECT COUNT(*) as c FROM clients').get() as any).c;

    const agents = db.prepare(`
      SELECT agent, status, completed_at FROM agent_runs
      WHERE id IN (SELECT MAX(id) FROM agent_runs GROUP BY agent)
    `).all() as any[];

    sendJson(res, {
      revenue: { total: totalRevenue, monthly: monthlyRevenue },
      expenses: { total: totalExpenses, monthly: monthlyExpenses },
      net: { total: totalRevenue - totalExpenses, monthly: monthlyRevenue - monthlyExpenses },
      mrr,
      arr: mrr * 12,
      leads: leadCount,
      clients: clientCount,
      budgetLimit: config.budget.monthlyLimit,
      budgetUsed: monthlyExpenses,
      agentHealth: agents.map(a => ({
        name: a.agent,
        status: a.status,
        lastRun: a.completed_at,
      })),
    });
    return;
  }

  if (pathname === '/api/kpi/agents') {
    const agentMetrics = db.prepare(`
      SELECT agent,
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(cost), 0) as total_cost,
        COALESCE(SUM(tokens_used), 0) as total_tokens
      FROM agent_runs
      GROUP BY agent
      ORDER BY total_cost DESC
    `).all() as any[];

    sendJson(res, {
      agents: agentMetrics.map(a => ({
        name: a.agent,
        totalRuns: a.total_runs,
        successRate: a.total_runs > 0 ? ((a.successful / a.total_runs) * 100).toFixed(1) + '%' : 'N/A',
        failedRuns: a.failed,
        totalCost: a.total_cost,
        totalTokens: a.total_tokens,
      })),
    });
    return;
  }

  if (pathname === '/api/kpi/pipeline') {
    const leadsByStatus = db.prepare(
      'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
    ).all() as any[];

    const totalLeads = leadsByStatus.reduce((s: number, l: any) => s + l.count, 0);
    const wonLeads = leadsByStatus.find((l: any) => l.status === 'closed_won')?.count || 0;
    const conversionRate = totalLeads > 0 ? ((wonLeads / totalLeads) * 100).toFixed(1) + '%' : '0%';

    sendJson(res, {
      funnel: Object.fromEntries(leadsByStatus.map((s: any) => [s.status, s.count])),
      totalLeads,
      wonLeads,
      conversionRate,
    });
    return;
  }

  if (pathname === '/api/kpi/financials') {
    const totalRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue'"
    ).get() as any).t;
    const totalExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense'"
    ).get() as any).t;

    const monthlyRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue' AND created_at >= ?"
    ).get(monthStartStr) as any).t;
    const monthlyExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense' AND created_at >= ?"
    ).get(monthStartStr) as any).t;

    const costBreakdown = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM transactions WHERE type = 'expense'
      GROUP BY category ORDER BY total DESC
    `).all() as any[];

    const budgetUsed = config.budget.monthlyLimit > 0
      ? (monthlyExpenses / config.budget.monthlyLimit) * 100
      : 0;

    const latestForecast = db.prepare(
      "SELECT data FROM financial_reports WHERE type = 'forecast' ORDER BY created_at DESC LIMIT 1"
    ).get() as any;

    sendJson(res, {
      pnl: {
        revenue: totalRevenue,
        expenses: totalExpenses,
        net: totalRevenue - totalExpenses,
      },
      monthly: {
        revenue: monthlyRevenue,
        expenses: monthlyExpenses,
        net: monthlyRevenue - monthlyExpenses,
      },
      budgetUtilization: budgetUsed.toFixed(1) + '%',
      costBreakdown: Object.fromEntries(costBreakdown.map((c: any) => [c.category, c.total])),
      forecast: latestForecast ? JSON.parse(latestForecast.data) : null,
    });
    return;
  }

  sendJson(res, { error: 'Unknown KPI endpoint' }, 404);
}

import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class AnalyticsAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('analytics', 'Analytics', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      this.markMessageProcessed(msg.id);
    }

    await this.trackContentPerformance();
    await this.trackLeadConversion();
    await this.trackRevenueAttribution();
    await this.predictChurn();

    // Weekly analytics report (on Mondays)
    if (new Date().getDay() === 1) {
      await this.generateWeeklyAnalytics();
    }

    const stats = this.getAnalyticsSummary();
    this.sendMessage('ceo', 'report', { agent: 'analytics', stats });
  }

  private async trackContentPerformance(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 10);

    const existing = db.prepare(
      "SELECT id FROM analytics_snapshots WHERE period = ? AND metric_type = 'content_performance'"
    ).get(currentPeriod);
    if (existing) return;

    const platformStats = db.prepare(`
      SELECT platform,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
        COUNT(engagement) as with_engagement
      FROM content
      GROUP BY platform
    `).all() as any[];

    const engagementData = db.prepare(`
      SELECT platform, engagement FROM content
      WHERE engagement IS NOT NULL AND status = 'published'
    `).all() as any[];

    const platformEngagement: Record<string, any> = {};
    for (const row of engagementData) {
      try {
        const eng = JSON.parse(row.engagement);
        if (!platformEngagement[row.platform]) {
          platformEngagement[row.platform] = { likes: 0, comments: 0, shares: 0, impressions: 0, count: 0 };
        }
        const p = platformEngagement[row.platform];
        p.likes += eng.likes || 0;
        p.comments += eng.comments || 0;
        p.shares += eng.shares || 0;
        p.impressions += eng.impressions || 0;
        p.count += 1;
      } catch { /* skip malformed engagement */ }
    }

    db.prepare(`
      INSERT INTO analytics_snapshots (period, metric_type, data, created_at)
      VALUES (?, 'content_performance', ?, datetime('now'))
    `).run(currentPeriod, JSON.stringify({ platformStats, platformEngagement }));

    this.log.info('Content performance tracked');
  }

  private async trackLeadConversion(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 10);

    const existing = db.prepare(
      "SELECT id FROM analytics_snapshots WHERE period = ? AND metric_type = 'lead_conversion'"
    ).get(currentPeriod);
    if (existing) return;

    const funnel = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status
    `).all() as any[];

    const totalLeads = funnel.reduce((s: number, f: any) => s + f.count, 0);
    const wonLeads = funnel.find((f: any) => f.status === 'closed_won')?.count || 0;
    const conversionRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0;

    // Monthly trend
    const monthlyLeads = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
      FROM leads GROUP BY month ORDER BY month DESC LIMIT 6
    `).all() as any[];

    db.prepare(`
      INSERT INTO analytics_snapshots (period, metric_type, data, created_at)
      VALUES (?, 'lead_conversion', ?, datetime('now'))
    `).run(currentPeriod, JSON.stringify({
      funnel: Object.fromEntries(funnel.map((f: any) => [f.status, f.count])),
      totalLeads,
      wonLeads,
      conversionRate: conversionRate.toFixed(1) + '%',
      monthlyTrend: monthlyLeads,
    }));

    this.log.info({ conversionRate: conversionRate.toFixed(1) }, 'Lead conversion tracked');
  }

  private async trackRevenueAttribution(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 10);

    const existing = db.prepare(
      "SELECT id FROM analytics_snapshots WHERE period = ? AND metric_type = 'revenue_attribution'"
    ).get(currentPeriod);
    if (existing) return;

    // Revenue by source
    const revenueBySource = db.prepare(`
      SELECT l.source, COALESCE(SUM(t.amount), 0) as revenue, COUNT(DISTINCT c.id) as clients
      FROM clients c
      JOIN leads l ON c.lead_id = l.id
      LEFT JOIN transactions t ON t.client_id = c.id AND t.type = 'revenue'
      GROUP BY l.source
    `).all() as any[];

    // Revenue by product
    const revenueByProduct = db.prepare(`
      SELECT s.product_name, COALESCE(SUM(s.amount), 0) as mrr, COUNT(*) as subscribers
      FROM subscriptions s
      WHERE s.status = 'active'
      GROUP BY s.product_name
    `).all() as any[];

    db.prepare(`
      INSERT INTO analytics_snapshots (period, metric_type, data, created_at)
      VALUES (?, 'revenue_attribution', ?, datetime('now'))
    `).run(currentPeriod, JSON.stringify({ revenueBySource, revenueByProduct }));

    this.log.info('Revenue attribution tracked');
  }

  async predictChurn(): Promise<void> {
    const db = getSqlite();
    const activeClients = db.prepare(`
      SELECT c.id, c.name, c.email, c.company, c.status, c.created_at
      FROM clients c WHERE c.status = 'active'
    `).all() as any[];

    for (const client of activeClients) {
      const signals: { type: string; severity: number; details: string }[] = [];

      // Check payment delays
      const overdueInvoices = (db.prepare(`
        SELECT COUNT(*) as c FROM invoices
        WHERE client_id = ? AND status = 'overdue'
      `).get(client.id) as any).c;

      if (overdueInvoices > 0) {
        signals.push({
          type: 'payment_delay',
          severity: overdueInvoices >= 3 ? 5 : overdueInvoices >= 2 ? 4 : 3,
          details: `${overdueInvoices} overdue invoices`,
        });
      }

      // Check support ticket frequency (high ticket count = potential churn)
      const recentTickets = (db.prepare(`
        SELECT COUNT(*) as c FROM support_tickets
        WHERE client_id = ? AND created_at >= datetime('now', '-30 days')
      `).get(client.id) as any).c;

      if (recentTickets >= 5) {
        signals.push({
          type: 'high_support_volume',
          severity: recentTickets >= 10 ? 4 : 3,
          details: `${recentTickets} tickets in last 30 days`,
        });
      }

      // Check contract expiry approaching
      const expiringContracts = db.prepare(`
        SELECT COUNT(*) as c FROM contracts
        WHERE client_id = ? AND expiry_date IS NOT NULL
        AND expiry_date <= datetime('now', '+30 days')
        AND expiry_date > datetime('now')
        AND status = 'active'
      `).get(client.id) as any;

      if (expiringContracts.c > 0) {
        signals.push({
          type: 'contract_expiry',
          severity: 3,
          details: `${expiringContracts.c} contracts expiring within 30 days`,
        });
      }

      // Record churn signals
      for (const signal of signals) {
        const existing = db.prepare(`
          SELECT id FROM churn_signals
          WHERE client_id = ? AND signal_type = ? AND resolved_at IS NULL
        `).get(client.id, signal.type);

        if (!existing) {
          db.prepare(`
            INSERT INTO churn_signals (client_id, signal_type, severity, details, detected_at)
            VALUES (?, ?, ?, ?, datetime('now'))
          `).run(client.id, signal.type, signal.severity, signal.details);

          if (signal.severity >= 4) {
            this.sendMessage('ceo', 'alert', {
              type: 'churn_risk',
              clientId: client.id,
              clientName: client.name,
              signal: signal.type,
              severity: signal.severity,
              details: signal.details,
            }, 2);
          }
        }
      }
    }
  }

  private async generateWeeklyAnalytics(): Promise<void> {
    const db = getSqlite();

    const contentStats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as new_this_week
      FROM content
    `).get() as any;

    const leadStats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as new_this_week,
        SUM(CASE WHEN status = 'closed_won' THEN 1 ELSE 0 END) as won
      FROM leads
    `).get() as any;

    const weeklyRevenue = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as t FROM transactions
      WHERE type = 'revenue' AND created_at >= datetime('now', '-7 days')
    `).get() as any).t;

    const churnSignals = (db.prepare(`
      SELECT COUNT(*) as c FROM churn_signals WHERE resolved_at IS NULL
    `).get() as any).c;

    try {
      const response = await this.askLLM(
        `You are a business analytics agent for ${this.config.company.name}. Generate a weekly analytics summary. Be concise and actionable.`,
        `Weekly Analytics Data:
Content: ${contentStats.total} total, ${contentStats.published} published, ${contentStats.new_this_week} new this week
Leads: ${leadStats.total} total, ${leadStats.new_this_week} new this week, ${leadStats.won} won
Weekly Revenue: $${weeklyRevenue.toFixed(2)}
Active Churn Signals: ${churnSignals}

Provide a brief (3-5 bullet points) executive summary with actionable insights.`
      );

      db.prepare(`
        INSERT INTO analytics_snapshots (period, metric_type, data, created_at)
        VALUES (?, 'weekly_report', ?, datetime('now'))
      `).run(
        new Date().toISOString().slice(0, 10),
        JSON.stringify({ summary: response.content, contentStats, leadStats, weeklyRevenue, churnSignals })
      );

      this.sendMessage('ceo', 'report', {
        type: 'weekly_analytics',
        summary: response.content,
        metrics: { contentStats, leadStats, weeklyRevenue, churnSignals },
      });

      this.log.info('Weekly analytics report generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate weekly analytics');
    }
  }

  private getAnalyticsSummary() {
    const db = getSqlite();
    const leadCount = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;
    const clientCount = (db.prepare('SELECT COUNT(*) as c FROM clients').get() as any).c;
    const churnSignals = (db.prepare(
      "SELECT COUNT(*) as c FROM churn_signals WHERE resolved_at IS NULL"
    ).get() as any).c;
    return { leads: leadCount, clients: clientCount, activeChurnSignals: churnSignals };
  }
}

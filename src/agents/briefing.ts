import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { TelegramClient } from '../platforms/telegram.js';
import type { HivemindConfig } from '../config/schema.js';

export class BriefingAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('briefing' as any, 'Briefing', config);
  }

  protected async execute(_messages: AgentMessage[]): Promise<void> {
    if (!this.config.briefing?.enabled) return;

    const today = new Date().toISOString().split('T')[0];
    const db = getSqlite();

    // Check if already generated today
    const existing = db.prepare('SELECT id FROM daily_briefings WHERE date = ?').get(today);
    if (existing) return;

    const metrics = this.trackMetrics();
    const pipelineSummary = this.getPipelineSummary();
    const exceptions = this.getExceptions();

    const recommendations = await this.generateRecommendations(pipelineSummary, exceptions, metrics);

    // Store briefing
    db.prepare(`
      INSERT INTO daily_briefings (date, pipeline_summary, exceptions, recommendations, metrics, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      today,
      JSON.stringify(pipelineSummary),
      JSON.stringify(exceptions),
      JSON.stringify(recommendations),
      JSON.stringify(metrics)
    );

    await this.deliverBriefing(today, pipelineSummary, exceptions, recommendations, metrics);
  }

  private getPipelineSummary(): Record<string, any> {
    const db = getSqlite();

    const stageCounts = db.prepare(`
      SELECT stage, COUNT(*) as count FROM leads
      WHERE stage IS NOT NULL
      GROUP BY stage
    `).all() as any[];

    const totalValue = (db.prepare(`
      SELECT COALESCE(SUM(c.contract_value), 0) as total
      FROM clients c
      JOIN leads l ON l.id = c.lead_id
      WHERE l.stage = 'won'
    `).get() as any).total;

    const newLeadsToday = (db.prepare(`
      SELECT COUNT(*) as c FROM leads WHERE created_at >= datetime('now', '-1 day')
    `).get() as any).c;

    const pendingApprovals = (db.prepare(`
      SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'
    `).get() as any).c;

    return {
      stages: stageCounts.reduce((acc: any, s: any) => { acc[s.stage] = s.count; return acc; }, {}),
      totalPipelineValue: totalValue,
      newLeadsToday,
      pendingApprovals,
    };
  }

  private getExceptions(): any[] {
    const db = getSqlite();
    const exceptions: any[] = [];

    // Stale leads
    const staleLeads = db.prepare(`
      SELECT id, name, stage, next_action_due FROM leads
      WHERE next_action_due IS NOT NULL
        AND next_action_due < datetime('now')
        AND stage NOT IN ('won', 'lost', 'dormant')
      ORDER BY next_action_due ASC LIMIT 10
    `).all() as any[];

    for (const lead of staleLeads) {
      exceptions.push({
        type: 'stale_lead',
        severity: 'warning',
        message: `${lead.name} (${lead.stage}) — overdue since ${lead.next_action_due}`,
        entityId: lead.id,
      });
    }

    // Overdue payments
    const overduePayments = db.prepare(`
      SELECT pl.*, l.name as lead_name
      FROM payment_links pl
      LEFT JOIN leads l ON l.id = pl.lead_id
      WHERE pl.status IN ('created', 'sent')
        AND pl.created_at < datetime('now', '-7 days')
    `).all() as any[];

    for (const pl of overduePayments) {
      exceptions.push({
        type: 'overdue_payment',
        severity: 'critical',
        message: `${pl.lead_name || 'Client'} — ${pl.currency} ${pl.amount} unpaid for 7+ days`,
        entityId: pl.id,
      });
    }

    // Expired approvals
    const expiredCount = (db.prepare(`
      SELECT COUNT(*) as c FROM approvals WHERE status = 'expired'
        AND expires_at >= datetime('now', '-1 day')
    `).get() as any).c;

    if (expiredCount > 0) {
      exceptions.push({
        type: 'expired_approvals',
        severity: 'info',
        message: `${expiredCount} approvals expired in the last 24 hours`,
      });
    }

    return exceptions;
  }

  private trackMetrics(): Record<string, any> {
    const db = getSqlite();

    // Average response time (time between lead creation and first outbound activity)
    const avgResponseTime = (db.prepare(`
      SELECT AVG(
        CAST((julianday(oa.created_at) - julianday(l.created_at)) * 24 AS REAL)
      ) as avg_hours
      FROM leads l
      JOIN opportunity_activities oa ON oa.lead_id = l.id AND oa.direction = 'outbound'
      WHERE l.created_at >= datetime('now', '-30 days')
    `).get() as any)?.avg_hours || 0;

    // Follow-up rate
    const leadsWithFollowUp = (db.prepare(`
      SELECT COUNT(DISTINCT lead_id) as c FROM opportunity_activities
      WHERE activity_type = 'follow_up' AND created_at >= datetime('now', '-30 days')
    `).get() as any).c;

    const totalLeads30d = (db.prepare(`
      SELECT COUNT(*) as c FROM leads WHERE created_at >= datetime('now', '-30 days')
    `).get() as any).c;

    const followUpRate = totalLeads30d > 0 ? (leadsWithFollowUp / totalLeads30d * 100) : 0;

    // Conversion rate
    const wonCount = (db.prepare(`
      SELECT COUNT(*) as c FROM leads WHERE stage = 'won' AND won_at >= datetime('now', '-30 days')
    `).get() as any).c;

    const conversionRate = totalLeads30d > 0 ? (wonCount / totalLeads30d * 100) : 0;

    // Revenue (30 days)
    const revenue30d = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions
      WHERE type = 'revenue' AND created_at >= datetime('now', '-30 days')
    `).get() as any).total;

    // Proposals sent
    const proposalsSent = (db.prepare(`
      SELECT COUNT(*) as c FROM opportunity_activities
      WHERE activity_type = 'proposal_sent' AND created_at >= datetime('now', '-30 days')
    `).get() as any).c;

    return {
      avgResponseTimeHours: Math.round(avgResponseTime * 10) / 10,
      followUpRate: Math.round(followUpRate * 10) / 10,
      conversionRate: Math.round(conversionRate * 10) / 10,
      revenue30d,
      proposalsSent,
      totalLeads30d,
      wonCount,
    };
  }

  private async generateRecommendations(
    pipeline: Record<string, any>,
    exceptions: any[],
    metrics: Record<string, any>
  ): Promise<string[]> {
    try {
      const response = await this.askLLM(
        `You are a revenue operations advisor for ${this.config.company.name}.\nProvide 3-5 actionable recommendations based on the data. Be specific and concise. Return a JSON array of strings.`,
        `Pipeline: ${JSON.stringify(pipeline)}\nExceptions: ${JSON.stringify(exceptions)}\nMetrics: ${JSON.stringify(metrics)}`,
        { json: true, maxTokens: 512 }
      );

      const parsed = JSON.parse(response.content);
      return Array.isArray(parsed) ? parsed : parsed.recommendations || [];
    } catch {
      return ['Review pipeline for stale leads', 'Follow up on pending proposals'];
    }
  }

  private async deliverBriefing(
    date: string,
    pipeline: Record<string, any>,
    exceptions: any[],
    recommendations: string[],
    metrics: Record<string, any>
  ): Promise<void> {
    const db = getSqlite();

    const stages = pipeline.stages || {};
    const stageLines = Object.entries(stages)
      .map(([stage, count]) => `  ${stage}: ${count}`)
      .join('\n');

    const exceptionLines = exceptions.length > 0
      ? exceptions.slice(0, 5).map(e => `  [${e.severity}] ${e.message}`).join('\n')
      : '  None';

    const recLines = recommendations.slice(0, 5).map((r, i) => `  ${i + 1}. ${r}`).join('\n');

    const briefingText = [
      `<b>Daily Briefing — ${date}</b>`,
      '',
      '<b>Pipeline:</b>',
      stageLines || '  Empty',
      `  New leads today: ${pipeline.newLeadsToday || 0}`,
      `  Pending approvals: ${pipeline.pendingApprovals || 0}`,
      '',
      '<b>Metrics (30d):</b>',
      `  Response time: ${metrics.avgResponseTimeHours}h`,
      `  Follow-up rate: ${metrics.followUpRate}%`,
      `  Conversion: ${metrics.conversionRate}%`,
      `  Revenue: ${this.config.defaultCurrency || 'INR'} ${metrics.revenue30d}`,
      `  Proposals sent: ${metrics.proposalsSent}`,
      '',
      '<b>Exceptions:</b>',
      exceptionLines,
      '',
      '<b>Recommendations:</b>',
      recLines,
    ].join('\n');

    // Deliver via Telegram
    try {
      const telegram = new TelegramClient(this.config);
      if (telegram.isConfigured) {
        const chatId = this.config.telegram?.chatId || '';
        await telegram.sendMessage(chatId, briefingText, 'HTML');

        db.prepare(`
          UPDATE daily_briefings SET delivered_via = 'telegram', delivered_at = datetime('now')
          WHERE date = ?
        `).run(date);
      }
    } catch (err) {
      this.log.error({ err }, 'Failed to deliver briefing via Telegram');
    }
  }
}

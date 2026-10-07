import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

export class OpsAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('ops', 'Ops', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    // Process alerts
    const alerts = messages.filter(m => m.type === 'alert');
    for (const alert of alerts) {
      this.log.warn({ alert: alert.payload }, 'Alert received');
      // Forward alerts to founder
      await this.forwardAlertToFounder(alert.payload);
      this.markMessageProcessed(alert.id);
    }

    // Process tasks
    const tasks = messages.filter(m => m.type === 'task');
    for (const task of tasks) {
      this.markMessageProcessed(task.id);
    }

    // Core monitoring duties
    await this.trackCosts();
    await this.checkBudget();
    await this.monitorAgentHealth();

    // Post daily digest to Notion
    await this.postDigestToNotion();

    // Report to CEO
    const financials = this.getFinancials();
    this.sendMessage('ceo', 'report', {
      agent: 'ops',
      financials,
      health: this.getHealthReport(),
    });
  }

  private async forwardAlertToFounder(payload: any): Promise<void> {
    try {
      const message = payload.message || payload.type || JSON.stringify(payload);
      await notifyFounder(this.config, 'alert', message, {
        subject: `Alert: ${payload.type || 'System Alert'}`,
        urgent: true,
      });
    } catch (err: any) {
      this.log.error({ err }, 'Failed to forward alert to founder');
    }
  }

  private async trackCosts(): Promise<void> {
    const db = getSqlite();

    // Aggregate LLM costs for current month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const costs = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE type = 'expense' AND created_at >= ?
    `).get(monthStart.toISOString()) as any;

    this.log.info({ monthlySpend: costs.total }, 'Monthly cost tracking');
  }

  private async checkBudget(): Promise<void> {
    const db = getSqlite();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const expenses = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE type = 'expense' AND created_at >= ?
    `).get(monthStart.toISOString()) as any).total;

    const revenue = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE type = 'revenue' AND created_at >= ?
    `).get(monthStart.toISOString()) as any).total;

    const budget = this.config.budget.monthlyLimit;
    const utilization = budget > 0 ? expenses / budget : 0;

    if (utilization >= this.config.budget.alertThreshold) {
      this.log.warn({
        expenses,
        budget,
        utilization: `${(utilization * 100).toFixed(1)}%`,
      }, 'Budget threshold reached');

      // Alert CEO
      this.sendMessage('ceo', 'alert', {
        type: 'budget_warning',
        expenses,
        budget,
        utilization,
        revenue,
        recommendation: utilization >= 1
          ? 'CRITICAL: Over budget. Consider switching to cheaper LLM model or pausing non-essential agents.'
          : 'Approaching budget limit. Monitor spending.',
      }, 3);

      // Notify founder via Telegram/email
      const pct = (utilization * 100).toFixed(1);
      await notifyFounder(this.config, 'alert',
        `Budget ${utilization >= 1 ? 'EXCEEDED' : 'warning'}: ${pct}% used ($${expenses.toFixed(2)} of $${budget}/month). Revenue: $${revenue.toFixed(2)}.`,
        { subject: `Budget ${utilization >= 1 ? 'Exceeded' : 'Warning'}: ${pct}%`, urgent: utilization >= 1 }
      ).catch(err => this.log.error({ err }, 'Failed to notify founder about budget'));

      // If over budget, suggest model degradation
      if (utilization >= 1) {
        this.sendMessage('broadcast', 'alert', {
          type: 'budget_exceeded',
          action: 'reduce_spending',
          message: 'Budget exceeded. Reducing LLM calls to essential operations only.',
        }, 3);
      }
    }

    // Track margin
    const margin = revenue > 0 ? ((revenue - expenses) / revenue) * 100 : -100;
    this.log.info({
      expenses,
      revenue,
      margin: `${margin.toFixed(1)}%`,
      budgetUtilization: `${(utilization * 100).toFixed(1)}%`,
    }, 'Financial summary');
  }

  private async monitorAgentHealth(): Promise<void> {
    const db = getSqlite();

    const agents = ['ceo', 'content', 'social', 'sales', 'client', 'ops'];
    const unhealthy: string[] = [];

    for (const agent of agents) {
      const lastRun = db.prepare(`
        SELECT status, completed_at, error
        FROM agent_runs
        WHERE agent = ?
        ORDER BY id DESC LIMIT 1
      `).get(agent) as any;

      if (lastRun?.status === 'failed') {
        unhealthy.push(agent);
        this.log.warn({ agent, error: lastRun.error }, 'Agent unhealthy');
      }
    }

    if (unhealthy.length > 0) {
      this.sendMessage('ceo', 'alert', {
        type: 'agent_health',
        unhealthy,
        message: `Agents with issues: ${unhealthy.join(', ')}`,
      }, 2);

      // Notify founder about agent failures
      await notifyFounder(this.config, 'alert',
        `Agent health issue: ${unhealthy.join(', ')} failed in last run.`,
        { subject: `Agent Failure: ${unhealthy.join(', ')}` }
      ).catch(err => this.log.error({ err }, 'Failed to notify founder about agent health'));
    }
  }

  private async postDigestToNotion(): Promise<void> {
    if (!this.config.notion?.apiKey) return;

    const dbId = this.config.notion.databases?.['reports'];
    if (!dbId) return;

    try {
      const financials = this.getFinancials();
      const health = this.getHealthReport();

      const body = [
        `# Daily Operations Report — ${new Date().toISOString().split('T')[0]}`,
        '',
        '## Financial Summary',
        `- Monthly Revenue: $${financials.monthlyRevenue.toFixed(2)}`,
        `- Monthly Expenses: $${financials.monthlyExpenses.toFixed(2)}`,
        `- Net: $${financials.monthlyNet.toFixed(2)}`,
        `- Budget Used: ${financials.budgetUsed}`,
        '',
        '## Agent Health',
        ...health.map(h => `- ${h.agent}: ${h.status} (${h.totalRuns} total runs)`),
        '',
        '## Cost Breakdown',
        ...Object.entries(financials.costByCategory).map(([cat, amt]) => `- ${cat}: $${(amt as number).toFixed(2)}`),
      ].join('\n');

      const { NotionClient } = await import('../platforms/notion.js');
      const notion = new NotionClient(this.config);
      await notion.createPage(dbId, `Ops Report — ${new Date().toISOString().split('T')[0]}`, body);
      this.log.info('Daily digest posted to Notion');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to post digest to Notion');
    }
  }

  getFinancials() {
    const db = getSqlite();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const totalRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
    ).get() as any).total;

    const totalExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
    ).get() as any).total;

    const monthlyRevenue = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions
      WHERE type = 'revenue' AND created_at >= ?
    `).get(monthStart.toISOString()) as any).total;

    const monthlyExpenses = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions
      WHERE type = 'expense' AND created_at >= ?
    `).get(monthStart.toISOString()) as any).total;

    const costByCategory = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM transactions WHERE type = 'expense' AND created_at >= ?
      GROUP BY category
    `).all(monthStart.toISOString()) as any[];

    return {
      totalRevenue,
      totalExpenses,
      netProfit: totalRevenue - totalExpenses,
      monthlyRevenue,
      monthlyExpenses,
      monthlyNet: monthlyRevenue - monthlyExpenses,
      budgetLimit: this.config.budget.monthlyLimit,
      budgetUsed: this.config.budget.monthlyLimit > 0
        ? `${((monthlyExpenses / this.config.budget.monthlyLimit) * 100).toFixed(1)}%`
        : 'No limit',
      costByCategory: Object.fromEntries(costByCategory.map(c => [c.category, c.total])),
    };
  }

  private getHealthReport() {
    const db = getSqlite();
    const agents = ['ceo', 'content', 'social', 'sales', 'client', 'ops'];

    return agents.map(agent => {
      const lastRun = db.prepare(`
        SELECT status, completed_at FROM agent_runs
        WHERE agent = ? ORDER BY id DESC LIMIT 1
      `).get(agent) as any;

      const runCount = (db.prepare(`
        SELECT COUNT(*) as count FROM agent_runs WHERE agent = ?
      `).get(agent) as any).count;

      return {
        agent,
        status: lastRun?.status || 'never_run',
        lastRun: lastRun?.completed_at || null,
        totalRuns: runCount,
      };
    });
  }
}

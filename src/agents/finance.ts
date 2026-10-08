import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Assets', type: 'asset', parent: null },
  { code: '1100', name: 'Cash', type: 'asset', parent: '1000' },
  { code: '1200', name: 'Accounts Receivable', type: 'asset', parent: '1000' },
  { code: '2000', name: 'Liabilities', type: 'liability', parent: null },
  { code: '2100', name: 'Accounts Payable', type: 'liability', parent: '2000' },
  { code: '3000', name: 'Equity', type: 'equity', parent: null },
  { code: '3100', name: 'Retained Earnings', type: 'equity', parent: '3000' },
  { code: '4000', name: 'Revenue', type: 'revenue', parent: null },
  { code: '4100', name: 'Service Revenue', type: 'revenue', parent: '4000' },
  { code: '4200', name: 'Subscription Revenue', type: 'revenue', parent: '4000' },
  { code: '5000', name: 'Expenses', type: 'expense', parent: null },
  { code: '5100', name: 'LLM Costs', type: 'expense', parent: '5000' },
  { code: '5200', name: 'Platform Fees', type: 'expense', parent: '5000' },
  { code: '5300', name: 'Tool Subscriptions', type: 'expense', parent: '5000' },
  { code: '5400', name: 'Marketing Expenses', type: 'expense', parent: '5000' },
];

export class FinanceAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('finance', 'Finance', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'report') {
        // Process billing/procurement reports
        this.log.info({ from: msg.fromAgent }, 'Financial report received');
      }
      this.markMessageProcessed(msg.id);
    }

    await this.ensureChartOfAccounts();
    await this.processNewTransactions();
    await this.generateMonthlyPnL();
    await this.forecastRevenue();
    await this.allocateBudgets();
    await this.checkBudgetUtilization();

    // Monthly board report (1st of each month)
    if (new Date().getDate() === 1) {
      await this.generateBoardReport();
    }

    // Report to CEO
    const financials = this.getFinancialSummary();
    this.sendMessage('ceo', 'report', { agent: 'finance', financials });
  }

  private async ensureChartOfAccounts(): Promise<void> {
    const db = getSqlite();
    const count = (db.prepare('SELECT COUNT(*) as count FROM accounts').get() as any).count;
    if (count > 0) return;

    for (const acct of DEFAULT_ACCOUNTS) {
      db.prepare(`
        INSERT OR IGNORE INTO accounts (code, name, type, parent_code, balance, currency, created_at)
        VALUES (?, ?, ?, ?, 0, 'USD', datetime('now'))
      `).run(acct.code, acct.name, acct.type, acct.parent);
    }
    this.log.info('Chart of accounts seeded');
  }

  private async processNewTransactions(): Promise<void> {
    const db = getSqlite();

    // Find transactions not yet journaled
    const unprocessed = db.prepare(`
      SELECT t.* FROM transactions t
      LEFT JOIN journal_entries je ON je.reference_type = 'transaction' AND je.reference_id = t.id
      WHERE je.id IS NULL
      ORDER BY t.created_at ASC
      LIMIT 50
    `).all() as any[];

    for (const txn of unprocessed) {
      let debitAccount: string;
      let creditAccount: string;

      if (txn.type === 'revenue') {
        debitAccount = '1100'; // Cash
        creditAccount = txn.category === 'subscription' ? '4200' : '4100'; // Subscription or Service Revenue
      } else {
        // Expense
        debitAccount = txn.category === 'llm_cost' ? '5100'
          : txn.category === 'platform_fee' ? '5200'
          : txn.category === 'tool_subscription' ? '5300'
          : '5400'; // Marketing/Other
        creditAccount = '1100'; // Cash
      }

      db.prepare(`
        INSERT INTO journal_entries (entry_date, description, reference_type, reference_id, debit_account, credit_account, amount, currency, posted_by, created_at)
        VALUES (?, ?, 'transaction', ?, ?, ?, ?, ?, 'finance', datetime('now'))
      `).run(txn.created_at, txn.description || txn.category, txn.id, debitAccount, creditAccount, txn.amount, txn.currency);
    }

    if (unprocessed.length > 0) {
      this.log.info({ count: unprocessed.length }, 'Transactions journaled');
    }
  }

  private async generateMonthlyPnL(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const existing = db.prepare(
      "SELECT id FROM financial_reports WHERE type = 'pnl' AND period = ?"
    ).get(currentPeriod);
    if (existing) return;

    const monthStart = `${currentPeriod}-01`;

    const revenue = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries
      WHERE credit_account LIKE '4%' AND entry_date >= ?
    `).get(monthStart) as any).total;

    const expenses = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries
      WHERE debit_account LIKE '5%' AND entry_date >= ?
    `).get(monthStart) as any).total;

    const expenseBreakdown = db.prepare(`
      SELECT debit_account as account, COALESCE(SUM(amount), 0) as total
      FROM journal_entries
      WHERE debit_account LIKE '5%' AND entry_date >= ?
      GROUP BY debit_account
    `).all(monthStart) as any[];

    const pnl = {
      period: currentPeriod,
      revenue,
      expenses,
      netIncome: revenue - expenses,
      margin: revenue > 0 ? ((revenue - expenses) / revenue * 100).toFixed(1) + '%' : 'N/A',
      expenseBreakdown: Object.fromEntries(expenseBreakdown.map(e => [e.account, e.total])),
    };

    db.prepare(`
      INSERT INTO financial_reports (type, period, data, generated_by, created_at)
      VALUES ('pnl', ?, ?, 'finance', datetime('now'))
    `).run(currentPeriod, JSON.stringify(pnl));

    this.log.info({ period: currentPeriod, netIncome: pnl.netIncome }, 'P&L report generated');
  }

  private async forecastRevenue(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const existing = db.prepare(
      "SELECT id FROM financial_reports WHERE type = 'forecast' AND period = ?"
    ).get(currentPeriod);
    if (existing) return;

    // Gather pipeline data
    const leadsByStatus = db.prepare(`
      SELECT status, COUNT(*) as count, COALESCE(AVG(score), 0) as avg_score
      FROM leads GROUP BY status
    `).all() as any[];

    const activeSubscriptions = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as mrr
      FROM subscriptions WHERE status = 'active'
    `).get() as any;

    const monthlyRevenue = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions
      WHERE type = 'revenue' AND created_at >= ?
    `).get(`${currentPeriod}-01`) as any).total;

    try {
      const response = await this.askLLM(
        `You are the CFO for ${this.config.company.name}. Analyze financial data and provide a revenue forecast. Output valid JSON only.`,
        `Forecast revenue based on:
Current monthly revenue: $${monthlyRevenue}
Active subscriptions: ${activeSubscriptions.count} ($${activeSubscriptions.mrr} MRR)
Lead pipeline: ${JSON.stringify(leadsByStatus)}
Products: ${(this.config.products || []).filter(p => p.active).length} active

Return JSON:
{
  "forecast_next_month": 0,
  "forecast_next_quarter": 0,
  "confidence": "high|medium|low",
  "mrr": 0,
  "risks": ["risk"],
  "opportunities": ["opportunity"],
  "narrative": "brief forecast narrative"
}`,
        { json: true }
      );

      let forecast: any;
      try {
        forecast = JSON.parse(response.content);
      } catch {
        forecast = { forecast_next_month: monthlyRevenue, confidence: 'low', narrative: 'Unable to generate forecast.' };
      }

      db.prepare(`
        INSERT INTO financial_reports (type, period, data, generated_by, created_at)
        VALUES ('forecast', ?, ?, 'finance', datetime('now'))
      `).run(currentPeriod, JSON.stringify(forecast));

      this.log.info({ forecast: forecast.forecast_next_month }, 'Revenue forecast generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate revenue forecast');
    }
  }

  private async allocateBudgets(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const existing = db.prepare(
      'SELECT COUNT(*) as count FROM budgets WHERE period = ?'
    ).get(currentPeriod) as any;
    if (existing.count > 0) {
      // Update spent amounts
      const departments = db.prepare(
        'SELECT DISTINCT department FROM budgets WHERE period = ?'
      ).all(currentPeriod) as any[];

      for (const dept of departments) {
        // Sum costs from agent_runs for agents in this department
        const spent = (db.prepare(`
          SELECT COALESCE(SUM(ar.cost), 0) as total
          FROM agent_runs ar
          JOIN employees e ON ar.agent = e.agent_name
          WHERE e.department = ? AND ar.started_at >= ?
        `).get(dept.department, `${currentPeriod}-01`) as any).total;

        db.prepare(`
          UPDATE budgets SET spent_amount = ?, updated_at = datetime('now')
          WHERE department = ? AND period = ?
        `).run(spent, dept.department, currentPeriod);
      }
      return;
    }

    // Create budgets for each department
    const budget = this.config.budget.monthlyLimit;
    const departments = [
      { name: 'executive', pct: 0.10 },
      { name: 'marketing', pct: 0.20 },
      { name: 'sales', pct: 0.15 },
      { name: 'client_services', pct: 0.10 },
      { name: 'operations', pct: 0.10 },
      { name: 'human_resources', pct: 0.05 },
      { name: 'finance', pct: 0.10 },
      { name: 'legal', pct: 0.05 },
      { name: 'billing', pct: 0.05 },
      { name: 'procurement', pct: 0.10 },
    ];

    for (const dept of departments) {
      db.prepare(`
        INSERT INTO budgets (department, period, allocated_amount, spent_amount, approved_by, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'finance', datetime('now'), datetime('now'))
      `).run(dept.name, currentPeriod, budget * dept.pct);
    }

    this.sendMessage('broadcast', 'strategy', {
      type: 'budget_allocation',
      period: currentPeriod,
      totalBudget: budget,
      message: `Monthly budgets allocated for ${currentPeriod}.`,
    });

    this.log.info({ period: currentPeriod, budget }, 'Budgets allocated');
  }

  private async checkBudgetUtilization(): Promise<void> {
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

      const pct = (utilization * 100).toFixed(1);
      await notifyFounder(this.config, 'alert',
        `Budget ${utilization >= 1 ? 'EXCEEDED' : 'warning'}: ${pct}% used ($${expenses.toFixed(2)} of $${budget}/month). Revenue: $${revenue.toFixed(2)}.`,
        { subject: `Budget ${utilization >= 1 ? 'Exceeded' : 'Warning'}: ${pct}%`, urgent: utilization >= 1 }
      ).catch(err => this.log.error({ err }, 'Failed to notify founder about budget'));

      if (utilization >= 1) {
        this.sendMessage('broadcast', 'alert', {
          type: 'budget_exceeded',
          action: 'reduce_spending',
          message: 'Budget exceeded. Reducing LLM calls to essential operations only.',
        }, 3);
      }
    }
  }

  private async generateBoardReport(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const existing = db.prepare(
      "SELECT id FROM financial_reports WHERE type = 'board_report' AND period = ?"
    ).get(currentPeriod);
    if (existing) return;

    const financials = this.getFinancialSummary();

    const mrr = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'"
    ).get() as any).t;

    const clientCount = (db.prepare('SELECT COUNT(*) as c FROM clients WHERE status = \'active\'').get() as any).c;
    const leadCount = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;

    const churnSignals = (db.prepare(
      'SELECT COUNT(*) as c FROM churn_signals WHERE resolved_at IS NULL'
    ).get() as any).c;

    const agentCosts = db.prepare(`
      SELECT agent, COALESCE(SUM(cost), 0) as total
      FROM agent_runs WHERE started_at >= ?
      GROUP BY agent ORDER BY total DESC
    `).all(`${currentPeriod}-01`) as any[];

    const latestForecast = db.prepare(
      "SELECT data FROM financial_reports WHERE type = 'forecast' ORDER BY created_at DESC LIMIT 1"
    ).get() as any;

    try {
      const response = await this.askLLM(
        `You are the CFO for ${this.config.company.name}. Generate a board-ready executive report. Be professional and data-driven.`,
        `Generate a monthly board report for ${currentPeriod}:

Financial Summary:
- Total Revenue: $${financials.totalRevenue.toFixed(2)}
- Monthly Revenue: $${financials.monthlyRevenue.toFixed(2)}
- Total Expenses: $${financials.totalExpenses.toFixed(2)}
- Monthly Expenses: $${financials.monthlyExpenses.toFixed(2)}
- Net Profit: $${financials.netProfit.toFixed(2)}
- MRR: $${mrr.toFixed(2)}
- ARR: $${(mrr * 12).toFixed(2)}

Business Metrics:
- Active Clients: ${clientCount}
- Total Leads: ${leadCount}
- Active Churn Signals: ${churnSignals}
- Budget Utilization: ${financials.budgetUsed}

Agent Costs: ${agentCosts.map(a => `${a.agent}: $${a.total.toFixed(4)}`).join(', ')}

Forecast: ${latestForecast ? JSON.parse(latestForecast.data).narrative || 'No forecast available' : 'No forecast available'}

Provide a structured board report with: Executive Summary, Financial Highlights, Key Metrics, Risks & Opportunities, and Recommendations.`
      );

      db.prepare(`
        INSERT INTO financial_reports (type, period, data, generated_by, created_at)
        VALUES ('board_report', ?, ?, 'finance', datetime('now'))
      `).run(currentPeriod, JSON.stringify({
        narrative: response.content,
        financials,
        mrr,
        arr: mrr * 12,
        clientCount,
        leadCount,
        churnSignals,
      }));

      // Notify founder
      await notifyFounder(this.config, 'report',
        `Board Report for ${currentPeriod}:\n\n${response.content}`,
        { subject: `Board Report — ${currentPeriod}` }
      ).catch(err => this.log.error({ err }, 'Failed to send board report to founder'));

      this.sendMessage('ceo', 'report', {
        type: 'board_report',
        period: currentPeriod,
        summary: response.content.slice(0, 500),
      });

      this.log.info({ period: currentPeriod }, 'Board report generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate board report');
    }
  }

  private getFinancialSummary() {
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
    const monthlyRevenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue' AND created_at >= ?"
    ).get(monthStart.toISOString()) as any).total;
    const monthlyExpenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense' AND created_at >= ?"
    ).get(monthStart.toISOString()) as any).total;

    return {
      totalRevenue, totalExpenses, netProfit: totalRevenue - totalExpenses,
      monthlyRevenue, monthlyExpenses, monthlyNet: monthlyRevenue - monthlyExpenses,
      budgetLimit: this.config.budget.monthlyLimit,
      budgetUsed: this.config.budget.monthlyLimit > 0
        ? `${((monthlyExpenses / this.config.budget.monthlyLimit) * 100).toFixed(1)}%`
        : 'No limit',
    };
  }
}

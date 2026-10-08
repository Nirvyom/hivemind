import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function financialsCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // All-time
  const totalRevenue = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
  ).get() as any).total;
  const totalExpenses = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
  ).get() as any).total;

  // Monthly
  const monthlyRevenue = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE type = 'revenue' AND created_at >= ?
  `).get(monthStart.toISOString()) as any).total;
  const monthlyExpenses = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE type = 'expense' AND created_at >= ?
  `).get(monthStart.toISOString()) as any).total;

  // Cost breakdown
  const costByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) as total
    FROM transactions WHERE type = 'expense'
    GROUP BY category ORDER BY total DESC
  `).all() as any[];

  // Revenue by client
  const revenueByClient = db.prepare(`
    SELECT c.name, COALESCE(SUM(t.amount), 0) as total
    FROM transactions t
    LEFT JOIN clients c ON t.client_id = c.id
    WHERE t.type = 'revenue'
    GROUP BY t.client_id
    ORDER BY total DESC
    LIMIT 10
  `).all() as any[];

  // Recent transactions
  const recent = db.prepare(`
    SELECT type, category, amount, description, created_at
    FROM transactions ORDER BY created_at DESC LIMIT 15
  `).all() as any[];

  // LLM cost by agent
  const costByAgent = db.prepare(`
    SELECT agent, COALESCE(SUM(cost), 0) as total_cost, COALESCE(SUM(tokens_used), 0) as total_tokens
    FROM agent_runs GROUP BY agent ORDER BY total_cost DESC
  `).all() as any[];

  console.log(chalk.bold.cyan('\n  Hivemind Financials\n'));

  // Overview
  console.log(chalk.bold('  All-Time'));
  console.log(`  Revenue:     ${chalk.green(`$${totalRevenue.toFixed(2)}`)}`);
  console.log(`  Expenses:    ${chalk.red(`$${totalExpenses.toFixed(2)}`)}`);
  const net = totalRevenue - totalExpenses;
  console.log(`  Net P&L:     ${net >= 0 ? chalk.green(`$${net.toFixed(2)}`) : chalk.red(`-$${Math.abs(net).toFixed(2)}`)}`);

  console.log(chalk.bold('\n  This Month'));
  console.log(`  Revenue:     ${chalk.green(`$${monthlyRevenue.toFixed(2)}`)}`);
  console.log(`  Expenses:    ${chalk.red(`$${monthlyExpenses.toFixed(2)}`)}`);
  const monthlyNet = monthlyRevenue - monthlyExpenses;
  console.log(`  Net:         ${monthlyNet >= 0 ? chalk.green(`$${monthlyNet.toFixed(2)}`) : chalk.red(`-$${Math.abs(monthlyNet).toFixed(2)}`)}`);

  // Budget
  const budgetUsed = config.budget.monthlyLimit > 0
    ? (monthlyExpenses / config.budget.monthlyLimit) * 100
    : 0;
  const budgetBar = generateBar(budgetUsed, 30);
  console.log(`\n  Budget:      $${monthlyExpenses.toFixed(2)} / $${config.budget.monthlyLimit}`);
  console.log(`  ${budgetBar} ${budgetUsed.toFixed(1)}%`);

  // Cost breakdown
  if (costByCategory.length > 0) {
    console.log(chalk.bold('\n  Cost Breakdown'));
    for (const cat of costByCategory) {
      console.log(`  ${cat.category.padEnd(20)} ${chalk.red(`$${cat.total.toFixed(4)}`)}`);
    }
  }

  // LLM costs by agent
  if (costByAgent.length > 0) {
    console.log(chalk.bold('\n  LLM Cost by Agent'));
    for (const agent of costByAgent) {
      const tokens = agent.total_tokens > 1000
        ? `${(agent.total_tokens / 1000).toFixed(1)}K`
        : agent.total_tokens;
      console.log(`  ${agent.agent.padEnd(12)} $${agent.total_cost.toFixed(4)}  (${tokens} tokens)`);
    }
  }

  // Revenue by client
  if (revenueByClient.length > 0 && revenueByClient[0].total > 0) {
    console.log(chalk.bold('\n  Revenue by Client'));
    for (const client of revenueByClient) {
      console.log(`  ${(client.name || 'Unknown').padEnd(20)} ${chalk.green(`$${client.total.toFixed(2)}`)}`);
    }
  }

  // Invoices & Billing
  const invoiceStats = db.prepare(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
    FROM invoices GROUP BY status ORDER BY total DESC
  `).all() as any[];

  if (invoiceStats.length > 0) {
    console.log(chalk.bold('\n  Invoices'));
    for (const stat of invoiceStats) {
      const color = stat.status === 'paid' ? chalk.green : stat.status === 'overdue' ? chalk.red : chalk.yellow;
      console.log(`  ${stat.status.padEnd(15)} ${String(stat.count).padEnd(5)} ${color(`$${stat.total.toFixed(2)}`)}`);
    }
  }

  // MRR (Monthly Recurring Revenue)
  const mrr = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'"
  ).get() as any).total;
  const arr = mrr * 12;
  if (mrr > 0) {
    console.log(chalk.bold('\n  Recurring Revenue'));
    console.log(`  MRR:         ${chalk.green(`$${mrr.toFixed(2)}`)}`);
    console.log(`  ARR:         ${chalk.green(`$${arr.toFixed(2)}`)}`);
  }

  // Budget by Department
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const budgetByDept = db.prepare(`
    SELECT department, allocated_amount, spent_amount
    FROM budgets WHERE period = ? ORDER BY allocated_amount DESC
  `).all(currentPeriod) as any[];

  if (budgetByDept.length > 0) {
    console.log(chalk.bold('\n  Budget by Department'));
    for (const dept of budgetByDept) {
      const pct = dept.allocated_amount > 0 ? ((dept.spent_amount / dept.allocated_amount) * 100).toFixed(0) : '0';
      const color = Number(pct) > 90 ? chalk.red : Number(pct) > 70 ? chalk.yellow : chalk.green;
      console.log(`  ${dept.department.padEnd(20)} ${color(`$${dept.spent_amount.toFixed(2)}`)} / $${dept.allocated_amount.toFixed(2)} (${pct}%)`);
    }
  }

  // Churn Signals
  const churnSignals = db.prepare(`
    SELECT cs.*, c.name as client_name
    FROM churn_signals cs
    JOIN clients c ON cs.client_id = c.id
    WHERE cs.resolved_at IS NULL
    ORDER BY cs.severity DESC
    LIMIT 10
  `).all() as any[];

  if (churnSignals.length > 0) {
    console.log(chalk.bold('\n  Churn Alerts'));
    for (const signal of churnSignals) {
      const severityColor = signal.severity >= 4 ? chalk.red : signal.severity >= 3 ? chalk.yellow : chalk.dim;
      console.log(`  ${severityColor(`P${signal.severity}`)} ${(signal.client_name || 'Unknown').padEnd(20)} ${signal.signal_type.padEnd(20)} ${chalk.dim(signal.details || '')}`);
    }
  }

  // Latest Board Report
  const boardReport = db.prepare(
    "SELECT data, period, created_at FROM financial_reports WHERE type = 'board_report' ORDER BY created_at DESC LIMIT 1"
  ).get() as any;

  if (boardReport) {
    const data = JSON.parse(boardReport.data);
    console.log(chalk.bold(`\n  Latest Board Report (${boardReport.period})`));
    const narrative = data.narrative || '';
    // Show first 500 chars
    console.log(`  ${chalk.dim(narrative.slice(0, 500))}${narrative.length > 500 ? '...' : ''}`);
  }

  // Recent transactions
  if (recent.length > 0) {
    console.log(chalk.bold('\n  Recent Transactions'));
    for (const tx of recent) {
      const icon = tx.type === 'revenue' ? chalk.green('+') : chalk.red('-');
      const amount = tx.type === 'revenue'
        ? chalk.green(`$${tx.amount.toFixed(4)}`)
        : chalk.red(`$${tx.amount.toFixed(4)}`);
      const time = new Date(tx.created_at).toLocaleString();
      console.log(`  ${icon} ${amount}  ${tx.category.padEnd(18)} ${chalk.dim(tx.description || '')}  ${chalk.dim(time)}`);
    }
  }

  console.log('');
}

function generateBar(percentage: number, width: number): string {
  const filled = Math.min(Math.round((percentage / 100) * width), width);
  const empty = width - filled;
  const color = percentage > 90 ? chalk.red : percentage > 70 ? chalk.yellow : chalk.green;
  return `[${color('█'.repeat(filled))}${chalk.dim('░'.repeat(empty))}]`;
}

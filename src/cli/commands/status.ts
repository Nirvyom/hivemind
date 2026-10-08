import chalk from 'chalk';
import { configExists, loadConfig, getDaemonPid } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';
import { createAgents } from '../../agents/index.js';

export async function statusCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const pid = getDaemonPid();
  const daemonStatus = pid ? chalk.green(`Running (PID: ${pid})`) : chalk.red('Stopped');

  console.log(chalk.bold.cyan('\n  Hivemind — Revenue Execution OS\n'));
  console.log(`  Company:  ${chalk.bold(config.company.name)}`);
  console.log(`  Daemon:   ${daemonStatus}`);
  console.log(`  LLM:      ${config.llm.provider} / ${config.llm.model}`);
  console.log(`  Budget:   $${config.budget.monthlyLimit}/month`);

  // Active agent health
  const agentSchedules = createAgents(config);
  const modeLabel = config.legacyAgents?.enabled
    ? `${agentSchedules.length} agents (full company mode)`
    : `${agentSchedules.length} revenue agents`;
  console.log(chalk.bold(`\n  Active Agents — ${modeLabel}\n`));

  const activeAgents = agentSchedules.map(s => ({
    name: s.agent.name,
    display: s.agent.name.charAt(0).toUpperCase() + s.agent.name.slice(1),
    interval: s.interval,
  }));

  for (const agent of activeAgents) {
    const lastRun = db.prepare(`
      SELECT status, completed_at, tokens_used, cost
      FROM agent_runs WHERE agent = ? ORDER BY id DESC LIMIT 1
    `).get(agent.name) as any;

    const totalRuns = (db.prepare(
      'SELECT COUNT(*) as count FROM agent_runs WHERE agent = ?'
    ).get(agent.name) as any).count;

    const failedRuns = (db.prepare(
      "SELECT COUNT(*) as count FROM agent_runs WHERE agent = ? AND status = 'failed'"
    ).get(agent.name) as any).count;

    const statusIcon = !lastRun ? '\u26aa'
      : lastRun.status === 'completed' ? '\u{1f7e2}'
      : lastRun.status === 'running' ? '\u{1f535}'
      : '\u{1f534}';

    const lastRunTime = lastRun?.completed_at
      ? timeSince(new Date(lastRun.completed_at))
      : 'never';

    console.log(`  ${statusIcon} ${chalk.bold(agent.display.padEnd(14))} [${agent.interval}]  Last: ${lastRunTime}  Runs: ${totalRuns}  Failed: ${failedRuns}`);
  }

  // Pipeline summary
  console.log(chalk.bold('\n  Sales Pipeline\n'));

  const stages = ['enquiry', 'qualified', 'responded', 'proposal_sent', 'negotiating', 'won', 'lost', 'dormant'];
  for (const stage of stages) {
    const count = (db.prepare('SELECT COUNT(*) as c FROM leads WHERE stage = ?').get(stage) as any).c;
    if (count > 0) {
      const color = stage === 'won' ? chalk.green : stage === 'lost' ? chalk.red : stage === 'dormant' ? chalk.dim : chalk.white;
      console.log(`  ${color(`${stage.padEnd(16)} ${count}`)}`);
    }
  }

  // Pending approvals
  const pendingApprovals = (db.prepare(
    "SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'"
  ).get() as any).c;

  if (pendingApprovals > 0) {
    console.log(chalk.bold('\n  Pending Approvals\n'));
    console.log(`  ${chalk.yellow(`${pendingApprovals} awaiting review`)} — run ${chalk.bold('hivemind approvals')}`);
  }

  // Exceptions
  const staleLeads = (db.prepare(`
    SELECT COUNT(*) as c FROM leads
    WHERE next_action_due IS NOT NULL AND next_action_due < datetime('now')
      AND stage NOT IN ('won', 'lost', 'dormant')
  `).get() as any).c;

  const overduePayments = (db.prepare(`
    SELECT COUNT(*) as c FROM payment_links
    WHERE status IN ('created', 'sent') AND created_at < datetime('now', '-7 days')
  `).get() as any).c;

  if (staleLeads > 0 || overduePayments > 0) {
    console.log(chalk.bold('\n  Exceptions\n'));
    if (staleLeads > 0) console.log(chalk.yellow(`  ${staleLeads} stale leads past due`));
    if (overduePayments > 0) console.log(chalk.red(`  ${overduePayments} overdue payment links`));
  }

  // Revenue summary
  console.log(chalk.bold('\n  Revenue\n'));

  const revenue = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
  ).get() as any).total;
  const expenses = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
  ).get() as any).total;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthlyExpenses = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE type = 'expense' AND created_at >= ?
  `).get(monthStart.toISOString()) as any).total;

  const currency = config.defaultCurrency || 'INR';
  console.log(`  Revenue:     ${chalk.green(`${currency} ${revenue.toFixed(2)}`)}`);
  console.log(`  Expenses:    ${chalk.red(`${currency} ${expenses.toFixed(2)}`)}`);
  const netAmount = revenue - expenses;
  console.log(`  Net:         ${netAmount >= 0 ? chalk.green(`${currency} ${netAmount.toFixed(2)}`) : chalk.red(`${currency} ${netAmount.toFixed(2)}`)}`);

  const budgetPct = config.budget.monthlyLimit > 0
    ? ((monthlyExpenses / config.budget.monthlyLimit) * 100).toFixed(1)
    : '0';
  console.log(`  Budget used: ${chalk.yellow(`${budgetPct}%`)} of $${config.budget.monthlyLimit}/month`);

  // Collected via Razorpay
  const collectedPayments = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM payment_links WHERE status = 'paid'"
  ).get() as any).total;

  if (collectedPayments > 0) {
    console.log(`  Collected:   ${chalk.green(`${currency} ${collectedPayments.toFixed(2)}`)} via payment links`);
  }

  // Platforms
  console.log(chalk.bold('\n  Integrations\n'));

  const telegramIcon = config.telegram?.botToken ? '\u2705' : '\u274c';
  console.log(`  ${telegramIcon} Telegram ${config.telegram?.botToken ? '(connected)' : '(not configured)'}`);

  const razorpayIcon = config.razorpay?.keyId ? '\u2705' : '\u274c';
  console.log(`  ${razorpayIcon} Razorpay ${config.razorpay?.keyId ? '(connected)' : '(not configured)'}`);

  const whatsappIcon = config.whatsapp?.enabled ? '\u2705' : '\u274c';
  console.log(`  ${whatsappIcon} WhatsApp webhook ${config.whatsapp?.enabled ? '(enabled)' : '(disabled)'}`);

  if (config.api?.enabled) {
    console.log(`  \u2705 API Server on port ${config.api.port || 9474}`);
  }

  if (config.founder) {
    console.log(`  \u{1f464} Founder: ${config.founder.name} (${config.founder.preferredChannel})`);
  }

  console.log('');
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

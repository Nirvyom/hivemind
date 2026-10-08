import chalk from 'chalk';
import { configExists, loadConfig, getDaemonPid } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';
import { createAgents } from '../../agents/index.js';

export async function dashboardCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();

  const render = () => {
    const db = getSqlite();

    console.clear();
    const pid = getDaemonPid();

    // Header
    console.log(chalk.bold.cyan('\u2554' + '\u2550'.repeat(62) + '\u2557'));
    console.log(chalk.bold.cyan(`\u2551  \u{1f41d} Hivemind Revenue OS \u2014 ${config.company.name.padEnd(36)}\u2551`));
    console.log(chalk.bold.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

    // Daemon status
    const status = pid ? chalk.green('\u25cf Running') : chalk.red('\u25cf Stopped');
    console.log(chalk.cyan(`\u2551  Daemon: ${status}${' '.repeat(49 - (pid ? 9 : 9))}\u2551`));
    console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

    // Active Agents
    const agentSchedules = createAgents(config);
    const modeTag = config.legacyAgents?.enabled ? ' (FULL COMPANY)' : '';
    const headerText = `ACTIVE AGENTS${modeTag}`;
    console.log(chalk.cyan('\u2551  ') + chalk.bold(headerText) + ' '.repeat(Math.max(0, 60 - headerText.length)) + chalk.cyan('\u2551'));
    const agents = agentSchedules.map(s => ({
      name: s.agent.name,
      display: s.agent.name.toUpperCase(),
      interval: s.interval,
    }));

    for (const agent of agents) {
      const lastRun = db.prepare(`
        SELECT status, completed_at FROM agent_runs
        WHERE agent = ? ORDER BY id DESC LIMIT 1
      `).get(agent.name) as any;

      const icon = !lastRun ? '\u26aa'
        : lastRun.status === 'completed' ? '\u{1f7e2}'
        : lastRun.status === 'running' ? '\u{1f535}'
        : '\u{1f534}';

      const time = lastRun?.completed_at ? timeSince(new Date(lastRun.completed_at)) : 'never';
      const line = `  ${icon} ${agent.display.padEnd(14)} [${agent.interval}]  Last: ${time}`;
      console.log(chalk.cyan('\u2551') + line.padEnd(62) + chalk.cyan('\u2551'));
    }

    console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

    // Pipeline
    console.log(chalk.cyan('\u2551  ') + chalk.bold('SALES PIPELINE') + ' '.repeat(46) + chalk.cyan('\u2551'));

    const stages = ['enquiry', 'qualified', 'responded', 'proposal_sent', 'negotiating', 'won', 'lost', 'dormant'];
    for (const stage of stages) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM leads WHERE stage = ?').get(stage) as any).c;
      if (count > 0) {
        const line = `  ${stage.padEnd(20)} ${count}`;
        console.log(chalk.cyan('\u2551') + line.padEnd(62) + chalk.cyan('\u2551'));
      }
    }

    const totalLeads = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE stage IS NOT NULL").get() as any).c;
    if (totalLeads === 0) {
      console.log(chalk.cyan('\u2551') + '  No leads yet'.padEnd(62) + chalk.cyan('\u2551'));
    }

    console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

    // Approvals
    const pendingApprovals = (db.prepare(
      "SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'"
    ).get() as any).c;

    console.log(chalk.cyan('\u2551  ') + chalk.bold('APPROVALS') + ' '.repeat(51) + chalk.cyan('\u2551'));
    const appLine = pendingApprovals > 0
      ? chalk.yellow(`  ${pendingApprovals} pending`)
      : chalk.green('  All clear');
    console.log(chalk.cyan('\u2551') + appLine.padEnd(62 + (pendingApprovals > 0 ? 10 : 10)) + chalk.cyan('\u2551'));

    console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

    // Revenue
    console.log(chalk.cyan('\u2551  ') + chalk.bold('REVENUE') + ' '.repeat(53) + chalk.cyan('\u2551'));

    const revenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue'"
    ).get() as any).t;
    const expenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense'"
    ).get() as any).t;

    const currency = config.defaultCurrency || 'INR';
    const revLine = `  Revenue: ${currency} ${revenue.toFixed(2)}  Expenses: ${currency} ${expenses.toFixed(2)}  Net: ${currency} ${(revenue - expenses).toFixed(2)}`;
    console.log(chalk.cyan('\u2551') + revLine.padEnd(62) + chalk.cyan('\u2551'));

    // Payment links
    const paidLinks = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM payment_links WHERE status = 'paid'"
    ).get() as any).t;
    const pendingLinks = (db.prepare(
      "SELECT COUNT(*) as c FROM payment_links WHERE status IN ('created', 'sent')"
    ).get() as any).c;

    if (paidLinks > 0 || pendingLinks > 0) {
      const payLine = `  Collected: ${currency} ${paidLinks.toFixed(2)}  Pending links: ${pendingLinks}`;
      console.log(chalk.cyan('\u2551') + payLine.padEnd(62) + chalk.cyan('\u2551'));
    }

    console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));

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
      console.log(chalk.cyan('\u2551  ') + chalk.bold('EXCEPTIONS') + ' '.repeat(50) + chalk.cyan('\u2551'));
      if (staleLeads > 0) {
        const staleLine = `  ${staleLeads} stale leads past due`;
        console.log(chalk.cyan('\u2551') + chalk.yellow(staleLine).padEnd(62 + 10) + chalk.cyan('\u2551'));
      }
      if (overduePayments > 0) {
        const overLine = `  ${overduePayments} overdue payment links`;
        console.log(chalk.cyan('\u2551') + chalk.red(overLine).padEnd(62 + 10) + chalk.cyan('\u2551'));
      }
      console.log(chalk.cyan('\u2560' + '\u2550'.repeat(62) + '\u2563'));
    }

    // Integrations
    console.log(chalk.cyan('\u2551  ') + chalk.bold('INTEGRATIONS') + ' '.repeat(48) + chalk.cyan('\u2551'));

    const telegramStatus = config.telegram?.botToken ? '\u2705 Connected' : '\u274c Not configured';
    console.log(chalk.cyan('\u2551') + `  Telegram:  ${telegramStatus}`.padEnd(62) + chalk.cyan('\u2551'));

    const razorpayStatus = config.razorpay?.keyId ? '\u2705 Connected' : '\u274c Not configured';
    console.log(chalk.cyan('\u2551') + `  Razorpay:  ${razorpayStatus}`.padEnd(62) + chalk.cyan('\u2551'));

    const whatsappStatus = config.whatsapp?.enabled ? '\u2705 Enabled' : '\u274c Disabled';
    console.log(chalk.cyan('\u2551') + `  WhatsApp:  ${whatsappStatus}`.padEnd(62) + chalk.cyan('\u2551'));

    console.log(chalk.cyan('\u255a' + '\u2550'.repeat(62) + '\u255d'));
    console.log(chalk.dim('\n  Press Ctrl+C to exit. Refreshes every 5s.\n'));
  };

  render();

  const interval = setInterval(render, 5000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.dim('\nDashboard closed.'));
    process.exit(0);
  });

  await new Promise(() => {});
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

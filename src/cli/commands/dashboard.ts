import chalk from 'chalk';
import { configExists, loadConfig, getDaemonPid } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function dashboardCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();

  // Use a simple refresh loop instead of Ink for broader compatibility
  const render = () => {
    const db = getSqlite();

    console.clear();
    const pid = getDaemonPid();

    // Header
    console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan(`║  🐝 Hivemind Dashboard — ${config.company.name.padEnd(34)}║`));
    console.log(chalk.bold.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Daemon status
    const status = pid ? chalk.green('● Running') : chalk.red('● Stopped');
    console.log(chalk.cyan(`║  Daemon: ${status}${' '.repeat(49 - (pid ? 9 : 9))}║`));
    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Agents
    console.log(chalk.cyan('║  ') + chalk.bold('AGENTS') + ' '.repeat(54) + chalk.cyan('║'));
    const agents = ['ceo', 'content', 'social', 'sales', 'client', 'ops'];
    const intervals: Record<string, string> = {
      ceo: '6h', content: '4h', social: '30m', sales: '2h', client: '1h', ops: '15m'
    };

    for (const agent of agents) {
      const lastRun = db.prepare(`
        SELECT status, completed_at FROM agent_runs
        WHERE agent = ? ORDER BY id DESC LIMIT 1
      `).get(agent) as any;

      const icon = !lastRun ? '⚪'
        : lastRun.status === 'completed' ? '🟢'
        : lastRun.status === 'running' ? '🔵'
        : '🔴';

      const time = lastRun?.completed_at ? timeSince(new Date(lastRun.completed_at)) : 'never';
      const line = `  ${icon} ${agent.toUpperCase().padEnd(10)} [${intervals[agent]}]  Last: ${time}`;
      console.log(chalk.cyan('║') + line.padEnd(62) + chalk.cyan('║'));
    }

    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Financials
    console.log(chalk.cyan('║  ') + chalk.bold('FINANCIALS') + ' '.repeat(50) + chalk.cyan('║'));

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const revenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'revenue'"
    ).get() as any).t;
    const expenses = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE type = 'expense'"
    ).get() as any).t;
    const monthlyExp = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as t FROM transactions
      WHERE type = 'expense' AND created_at >= ?
    `).get(monthStart.toISOString()) as any).t;

    const budgetPct = config.budget.monthlyLimit > 0
      ? ((monthlyExp / config.budget.monthlyLimit) * 100).toFixed(0)
      : '0';

    const revLine = `  Revenue:  $${revenue.toFixed(2)}    Expenses: $${expenses.toFixed(2)}    Net: $${(revenue - expenses).toFixed(2)}`;
    console.log(chalk.cyan('║') + revLine.padEnd(62) + chalk.cyan('║'));

    const budgetLine = `  Budget:   ${budgetPct}% of $${config.budget.monthlyLimit}/mo`;
    console.log(chalk.cyan('║') + budgetLine.padEnd(62) + chalk.cyan('║'));

    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Content Pipeline
    console.log(chalk.cyan('║  ') + chalk.bold('CONTENT PIPELINE') + ' '.repeat(44) + chalk.cyan('║'));

    const contentStats = db.prepare(
      'SELECT status, COUNT(*) as c FROM content GROUP BY status'
    ).all() as any[];

    if (contentStats.length > 0) {
      for (const stat of contentStats) {
        const line = `  ${stat.status.padEnd(20)} ${stat.c}`;
        console.log(chalk.cyan('║') + line.padEnd(62) + chalk.cyan('║'));
      }
    } else {
      console.log(chalk.cyan('║') + '  No content yet'.padEnd(62) + chalk.cyan('║'));
    }

    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Lead Pipeline
    console.log(chalk.cyan('║  ') + chalk.bold('LEAD PIPELINE') + ' '.repeat(47) + chalk.cyan('║'));

    const leadStats = db.prepare(
      'SELECT status, COUNT(*) as c FROM leads GROUP BY status'
    ).all() as any[];

    if (leadStats.length > 0) {
      for (const stat of leadStats) {
        const line = `  ${stat.status.padEnd(20)} ${stat.c}`;
        console.log(chalk.cyan('║') + line.padEnd(62) + chalk.cyan('║'));
      }
    } else {
      console.log(chalk.cyan('║') + '  No leads yet'.padEnd(62) + chalk.cyan('║'));
    }

    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Product Catalog
    const activeProducts = (config.products || []).filter(p => p.active);
    if (activeProducts.length > 0) {
      console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));
      console.log(chalk.cyan('║  ') + chalk.bold('PRODUCTS') + ` (${activeProducts.length} active)`.padEnd(52) + chalk.cyan('║'));
      for (const product of activeProducts.slice(0, 5)) {
        const tiers = product.pricing.map(t => `$${t.price}`).join('/');
        const line = `  ${product.name.padEnd(20)} ${tiers || 'Custom'}`;
        console.log(chalk.cyan('║') + line.padEnd(62) + chalk.cyan('║'));
      }
      if (activeProducts.length > 5) {
        const moreLine = `  ... and ${activeProducts.length - 5} more`;
        console.log(chalk.cyan('║') + moreLine.padEnd(62) + chalk.cyan('║'));
      }
    }

    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════╣'));

    // Platforms & Integrations
    console.log(chalk.cyan('║  ') + chalk.bold('PLATFORMS & INTEGRATIONS') + ' '.repeat(38) + chalk.cyan('║'));
    for (const account of config.socialAccounts) {
      const icon = account.enabled ? '✅' : '❌';
      const line = `  ${icon} ${account.platform.padEnd(12)} ${account.handle ? `@${account.handle}` : ''} [${account.authMethod}]`;
      console.log(chalk.cyan('║') + line.padEnd(62) + chalk.cyan('║'));
    }

    // Notion status
    const notionStatus = config.notion?.apiKey ? '✅ Connected' : '❌ Not configured';
    const notionLine = `  Notion:    ${notionStatus}`;
    console.log(chalk.cyan('║') + notionLine.padEnd(62) + chalk.cyan('║'));

    // Telegram status
    const telegramStatus = config.telegram?.botToken ? '✅ Connected' : '❌ Not configured';
    const telegramLine = `  Telegram:  ${telegramStatus}`;
    console.log(chalk.cyan('║') + telegramLine.padEnd(62) + chalk.cyan('║'));

    // Company email
    if (config.companyEmail?.address) {
      const emailLine = `  Email:     ${config.companyEmail.address}`;
      console.log(chalk.cyan('║') + emailLine.padEnd(62) + chalk.cyan('║'));
    }

    if (config.socialAccounts.length === 0 && !config.notion && !config.telegram) {
      console.log(chalk.cyan('║') + '  No platforms configured'.padEnd(62) + chalk.cyan('║'));
    }

    console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════╝'));
    console.log(chalk.dim('\n  Press Ctrl+C to exit. Refreshes every 5s.\n'));
  };

  // Initial render
  render();

  // Refresh loop
  const interval = setInterval(render, 5000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.dim('\nDashboard closed.'));
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

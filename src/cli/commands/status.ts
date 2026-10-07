import chalk from 'chalk';
import { configExists, loadConfig, getDaemonPid } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

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

  console.log(chalk.bold.cyan('\n  Hivemind Status\n'));
  console.log(`  Company:  ${chalk.bold(config.company.name)}`);
  console.log(`  Daemon:   ${daemonStatus}`);
  console.log(`  LLM:      ${config.llm.provider} / ${config.llm.model}`);
  console.log(`  Budget:   $${config.budget.monthlyLimit}/month`);

  // Agent health
  console.log(chalk.bold('\n  Agent Status\n'));

  const agents = [
    { name: 'ceo', display: 'CEO', interval: '6h' },
    { name: 'content', display: 'Content', interval: '4h' },
    { name: 'social', display: 'Social', interval: '30m' },
    { name: 'sales', display: 'Sales', interval: '2h' },
    { name: 'client', display: 'Client', interval: '1h' },
    { name: 'ops', display: 'Ops', interval: '15m' },
  ];

  for (const agent of agents) {
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

    const statusIcon = !lastRun ? '⚪'
      : lastRun.status === 'completed' ? '🟢'
      : lastRun.status === 'running' ? '🔵'
      : '🔴';

    const lastRunTime = lastRun?.completed_at
      ? timeSince(new Date(lastRun.completed_at))
      : 'never';

    console.log(`  ${statusIcon} ${chalk.bold(agent.display.padEnd(10))} [${agent.interval}]  Last: ${lastRunTime}  Runs: ${totalRuns}  Failed: ${failedRuns}`);
  }

  // Financial summary
  console.log(chalk.bold('\n  Financials\n'));

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const revenue = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
  ).get() as any).total;
  const expenses = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
  ).get() as any).total;
  const monthlyExpenses = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE type = 'expense' AND created_at >= ?
  `).get(monthStart.toISOString()) as any).total;

  const budgetPct = config.budget.monthlyLimit > 0
    ? ((monthlyExpenses / config.budget.monthlyLimit) * 100).toFixed(1)
    : '0';

  console.log(`  Revenue:     ${chalk.green(`$${revenue.toFixed(2)}`)}`);
  console.log(`  Expenses:    ${chalk.red(`$${expenses.toFixed(2)}`)}`);
  const netAmount = revenue - expenses;
  const netFormatted = `$${netAmount.toFixed(2)}`;
  console.log(`  Net:         ${netAmount >= 0 ? chalk.green(netFormatted) : chalk.red(netFormatted)}`);
  console.log(`  Budget used: ${chalk.yellow(`${budgetPct}%`)} of $${config.budget.monthlyLimit}/month`);

  // Content summary
  const contentStats = db.prepare(
    'SELECT status, COUNT(*) as count FROM content GROUP BY status'
  ).all() as any[];

  if (contentStats.length > 0) {
    console.log(chalk.bold('\n  Content Pipeline\n'));
    for (const stat of contentStats) {
      console.log(`  ${stat.status.padEnd(20)} ${stat.count}`);
    }
  }

  // Lead summary
  const leadStats = db.prepare(
    'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
  ).all() as any[];

  if (leadStats.length > 0) {
    console.log(chalk.bold('\n  Lead Pipeline\n'));
    for (const stat of leadStats) {
      console.log(`  ${stat.status.padEnd(20)} ${stat.count}`);
    }
  }

  // Product catalog
  const products = config.products || [];
  const activeProducts = products.filter(p => p.active);
  if (products.length > 0) {
    console.log(chalk.bold('\n  Product Catalog\n'));
    console.log(`  Total: ${products.length}  Active: ${activeProducts.length}`);
    for (const product of activeProducts) {
      const tiers = product.pricing.map(t => `$${t.price}/${t.billingCycle}`).join(', ');
      console.log(`  - ${product.name}${product.category ? ` [${product.category}]` : ''} ${tiers ? `(${tiers})` : ''}`);
    }
  }

  // Social accounts
  console.log(chalk.bold('\n  Connected Platforms\n'));
  for (const account of config.socialAccounts) {
    const icon = account.enabled ? '✅' : '❌';
    console.log(`  ${icon} ${account.platform} ${account.handle ? `(@${account.handle})` : ''} [${account.authMethod}]`);
  }

  // Notion & Telegram status
  const notionIcon = config.notion?.apiKey ? '✅' : '❌';
  console.log(`  ${notionIcon} Notion ${config.notion?.apiKey ? '(connected)' : '(not configured)'}`);

  const telegramIcon = config.telegram?.botToken ? '✅' : '❌';
  console.log(`  ${telegramIcon} Telegram ${config.telegram?.botToken ? '(connected)' : '(not configured)'}`);

  // Company email
  if (config.companyEmail?.address) {
    console.log(`  ✅ Company Email: ${config.companyEmail.address}`);
  }

  // Founder contact
  if (config.founder) {
    console.log(`  👤 Founder: ${config.founder.name} (${config.founder.preferredChannel})`);
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

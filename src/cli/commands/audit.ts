import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function auditCommand(agent?: string, opts?: any): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const limit = opts?.lines ? parseInt(opts.lines, 10) : 30;

  console.log(chalk.bold.cyan('\n  Audit Log\n'));

  let query: string;
  let params: any[];

  if (agent) {
    query = `
      SELECT * FROM audit_log
      WHERE agent = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params = [agent, limit];
    console.log(`  ${chalk.dim(`Filtering by agent: ${agent}`)}\n`);
  } else {
    query = `
      SELECT * FROM audit_log
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params = [limit];
  }

  const entries = db.prepare(query).all(...params) as any[];

  if (entries.length === 0) {
    console.log('  No audit log entries found.\n');
    return;
  }

  for (const entry of entries) {
    const costStr = entry.cost > 0 ? chalk.yellow(` $${entry.cost.toFixed(6)}`) : '';
    const details = entry.details ? JSON.parse(entry.details) : {};
    const detailStr = Object.keys(details).length > 0
      ? chalk.dim(` ${JSON.stringify(details).slice(0, 80)}`)
      : '';

    console.log(
      `  ${chalk.dim(entry.timestamp)} ${chalk.bold(entry.agent.padEnd(16))} ${entry.action.padEnd(20)} ${entry.entity_type}${entry.entity_id ? `:${entry.entity_id}` : ''}${costStr}${detailStr}`
    );
  }

  // Summary
  const totalCost = (db.prepare(
    agent
      ? "SELECT COALESCE(SUM(cost), 0) as c FROM audit_log WHERE agent = ?"
      : "SELECT COALESCE(SUM(cost), 0) as c FROM audit_log"
  ).get(...(agent ? [agent] : [])) as any).c;

  const totalEntries = (db.prepare(
    agent
      ? "SELECT COUNT(*) as c FROM audit_log WHERE agent = ?"
      : "SELECT COUNT(*) as c FROM audit_log"
  ).get(...(agent ? [agent] : [])) as any).c;

  console.log(`\n  ${chalk.dim(`Showing ${entries.length} of ${totalEntries} entries. Total cost: $${totalCost.toFixed(6)}`)}\n`);
}

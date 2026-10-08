import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function competitorsCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  console.log(chalk.bold.cyan('\n  Competitor Intelligence\n'));

  const competitors = db.prepare(`
    SELECT * FROM competitors ORDER BY last_analyzed_at DESC NULLS LAST
  `).all() as any[];

  if (competitors.length === 0) {
    console.log('  No competitors tracked. Add competitors to config.json.\n');
    return;
  }

  for (const comp of competitors) {
    console.log(`  ${chalk.bold(comp.name)}${comp.website ? ` (${comp.website})` : ''}`);
    console.log(`  ${chalk.dim(`Category: ${comp.category || 'N/A'}  Last analyzed: ${comp.last_analyzed_at || 'never'}`)}`);
    if (comp.description) {
      console.log(`  ${comp.description.slice(0, 100)}${comp.description.length > 100 ? '...' : ''}`);
    }

    // Latest report
    const report = db.prepare(`
      SELECT analysis, threats, opportunities, created_at FROM competitor_reports
      WHERE competitor_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(comp.id) as any;

    if (report) {
      const threats = report.threats ? JSON.parse(report.threats) : [];
      const opportunities = report.opportunities ? JSON.parse(report.opportunities) : [];

      if (threats.length > 0) {
        console.log(`  ${chalk.red('Threats:')} ${threats.join('; ')}`);
      }
      if (opportunities.length > 0) {
        console.log(`  ${chalk.green('Opportunities:')} ${opportunities.join('; ')}`);
      }
    }
    console.log('');
  }

  console.log(`  ${chalk.dim(`Total: ${competitors.length} competitors tracked`)}\n`);
}

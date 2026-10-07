import chalk from 'chalk';
import { configExists } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function leadsCommand(action: string): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  initializeDatabase();
  const db = getSqlite();

  switch (action) {
    case 'list': {
      const leads = db.prepare(`
        SELECT id, name, email, company, source, status, score, last_contacted_at, created_at
        FROM leads ORDER BY score DESC, created_at DESC
        LIMIT 50
      `).all() as any[];

      if (leads.length === 0) {
        console.log(chalk.yellow('\nNo leads yet. The Sales agent will generate them.\n'));
        return;
      }

      console.log(chalk.bold.cyan(`\n  Leads (${leads.length})\n`));

      const statusColors: Record<string, (s: string) => string> = {
        new: chalk.white,
        contacted: chalk.blue,
        qualified: chalk.yellow,
        proposal: chalk.magenta,
        closed_won: chalk.green,
        closed_lost: chalk.red,
      };

      for (const lead of leads) {
        const colorFn = statusColors[lead.status] || chalk.white;
        const score = lead.score ? chalk.dim(`[${lead.score}]`) : '';
        const company = lead.company ? chalk.dim(` @ ${lead.company}`) : '';
        const lastContact = lead.last_contacted_at
          ? chalk.dim(` | Last: ${lead.last_contacted_at}`)
          : '';

        console.log(`  ${colorFn(`●`)} ${chalk.bold(lead.name)}${company} ${score}`);
        console.log(`    ${colorFn(lead.status.padEnd(15))} ${lead.source} ${lead.email ? `| ${lead.email}` : ''}${lastContact}`);
      }

      // Summary
      const statsByStatus = db.prepare(
        'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
      ).all() as any[];

      console.log(chalk.bold('\n  Pipeline Summary\n'));
      for (const stat of statsByStatus) {
        const colorFn = statusColors[stat.status] || chalk.white;
        console.log(`  ${colorFn(`${stat.status.padEnd(15)} ${stat.count}`)}`);
      }

      console.log('');
      break;
    }

    default:
      console.log(chalk.red(`Unknown leads action: ${action}`));
  }
}

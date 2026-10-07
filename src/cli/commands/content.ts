import chalk from 'chalk';
import { select, confirm } from '@inquirer/prompts';
import { configExists } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function contentCommand(action: string, opts?: { id?: string }): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  initializeDatabase();
  const db = getSqlite();

  switch (action) {
    case 'preview': {
      const pending = db.prepare(`
        SELECT id, type, platform, title, body, hashtags, status, created_at
        FROM content
        WHERE status IN ('draft', 'pending_approval')
        ORDER BY created_at DESC
        LIMIT 20
      `).all() as any[];

      if (pending.length === 0) {
        console.log(chalk.yellow('\nNo pending content to preview.\n'));
        return;
      }

      console.log(chalk.bold.cyan(`\n  Pending Content (${pending.length} items)\n`));

      for (const item of pending) {
        const hashtags = JSON.parse(item.hashtags || '[]');
        console.log(chalk.bold(`  #${item.id} [${item.platform}] ${item.type}`));
        console.log(chalk.dim(`  Status: ${item.status} | Created: ${item.created_at}`));
        if (item.title) console.log(chalk.white(`  Title: ${item.title}`));
        console.log(chalk.white(`  ${item.body.substring(0, 200)}${item.body.length > 200 ? '...' : ''}`));
        if (hashtags.length > 0) {
          console.log(chalk.blue(`  ${hashtags.map((h: string) => `#${h}`).join(' ')}`));
        }
        console.log('');
      }
      break;
    }

    case 'approve': {
      if (opts?.id) {
        const item = db.prepare('SELECT * FROM content WHERE id = ?').get(opts.id) as any;
        if (!item) {
          console.log(chalk.red(`Content #${opts.id} not found.`));
          return;
        }
        db.prepare(`
          UPDATE content SET status = 'approved', updated_at = datetime('now') WHERE id = ?
        `).run(opts.id);
        console.log(chalk.green(`Content #${opts.id} approved.`));
      } else {
        // Interactive approval
        const pending = db.prepare(`
          SELECT id, platform, title, body, status
          FROM content WHERE status = 'pending_approval'
          ORDER BY created_at ASC
        `).all() as any[];

        if (pending.length === 0) {
          console.log(chalk.yellow('\nNo content pending approval.\n'));
          return;
        }

        for (const item of pending) {
          console.log(chalk.bold(`\n  #${item.id} [${item.platform}]`));
          if (item.title) console.log(chalk.white(`  ${item.title}`));
          console.log(chalk.dim(`  ${item.body.substring(0, 300)}`));

          const approve = await confirm({
            message: `Approve this content?`,
            default: true,
          });

          if (approve) {
            db.prepare(`
              UPDATE content SET status = 'approved', updated_at = datetime('now') WHERE id = ?
            `).run(item.id);
            console.log(chalk.green(`  Approved ✓`));
          } else {
            console.log(chalk.yellow(`  Skipped`));
          }
        }
      }
      break;
    }

    default:
      console.log(chalk.red(`Unknown content action: ${action}`));
  }
}

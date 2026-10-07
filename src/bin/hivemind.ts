#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from '../cli/commands/init.js';
import { startCommand } from '../cli/commands/start.js';
import { stopCommand } from '../cli/commands/stop.js';
import { statusCommand } from '../cli/commands/status.js';
import { dashboardCommand } from '../cli/commands/dashboard.js';
import { logsCommand } from '../cli/commands/logs.js';
import { contentCommand } from '../cli/commands/content.js';
import { leadsCommand } from '../cli/commands/leads.js';
import { financialsCommand } from '../cli/commands/financials.js';

const program = new Command();

program
  .name('hivemind')
  .description('Autonomous AI Company Builder')
  .version('0.1.0');

program
  .command('init')
  .description('Onboarding wizard — set up your company')
  .action(initCommand);

program
  .command('start')
  .description('Start the Hivemind daemon')
  .action(startCommand);

program
  .command('stop')
  .description('Stop the Hivemind daemon')
  .action(stopCommand);

program
  .command('status')
  .description('Agent health + financials overview')
  .action(statusCommand);

program
  .command('dashboard')
  .description('Live TUI dashboard')
  .action(dashboardCommand);

program
  .command('logs [agent]')
  .description('Tail agent logs')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(logsCommand);

const contentCmd = program
  .command('content')
  .description('Content management');

contentCmd
  .command('preview')
  .description('Preview pending content')
  .action(async () => { await contentCommand('preview'); });

contentCmd
  .command('approve')
  .description('Approve pending content')
  .option('--id <id>', 'Content ID to approve')
  .action(async (opts) => { await contentCommand('approve', opts); });

const leadsCmd = program
  .command('leads')
  .description('Lead management');

leadsCmd
  .command('list')
  .description('List all leads')
  .action(async () => { await leadsCommand('list'); });

program
  .command('financials')
  .description('Financial overview')
  .action(financialsCommand);

program.parse();

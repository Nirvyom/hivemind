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
import { agentsCommand } from '../cli/commands/agents.js';
import { ticketsCommand } from '../cli/commands/tickets.js';
import { competitorsCommand } from '../cli/commands/competitors.js';
import { auditCommand } from '../cli/commands/audit.js';
import { pipelineCommand } from '../cli/commands/pipeline.js';
import { approvalsCommand, approveCommand, rejectCommand, briefingCommand, captureCommand } from '../cli/commands/approvals.js';

const program = new Command();

program
  .name('hivemind')
  .description('Revenue Execution OS — Approval-first AI agents for service businesses')
  .version('0.2.0');

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
  .description('Pipeline, approvals, and agent overview')
  .action(statusCommand);

program
  .command('dashboard')
  .description('Live TUI dashboard')
  .action(dashboardCommand);

program
  .command('pipeline [stage]')
  .description('View sales pipeline by stage')
  .action(async (stage?: string) => { await pipelineCommand(stage); });

program
  .command('approvals')
  .description('List pending approvals')
  .action(approvalsCommand);

program
  .command('approve <id>')
  .description('Approve a pending action')
  .action(async (id: string) => { await approveCommand(id); });

program
  .command('reject <id>')
  .description('Reject a pending action')
  .option('-n, --note <note>', 'Rejection reason')
  .action(async (id: string, opts: any) => { await rejectCommand(id, opts.note); });

program
  .command('briefing')
  .description('Show latest daily briefing')
  .action(briefingCommand);

program
  .command('capture')
  .description('Quick-add a lead')
  .requiredOption('--name <name>', 'Lead name')
  .option('--email <email>', 'Email address')
  .option('--company <company>', 'Company name')
  .option('--phone <phone>', 'Phone number')
  .option('--source <source>', 'Lead source', 'manual')
  .option('--requirements <requirements>', 'Requirements')
  .option('--budget <budget>', 'Budget range')
  .option('--urgency <urgency>', 'Urgency (low/normal/high)', 'normal')
  .action(async (opts: any) => { await captureCommand(opts); });

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

program
  .command('agents')
  .description('List all agents with department, role, health')
  .action(agentsCommand);

const ticketsCmd = program
  .command('tickets')
  .description('Support ticket management');

ticketsCmd
  .command('list')
  .description('List support tickets')
  .option('--status <status>', 'Filter by status')
  .action(async (opts) => { await ticketsCommand('list', opts); });

ticketsCmd
  .command('create')
  .description('Create a support ticket')
  .option('--subject <subject>', 'Ticket subject')
  .option('--body <body>', 'Ticket body')
  .option('--priority <priority>', 'Priority (1-5)', '3')
  .action(async (opts) => { await ticketsCommand('create', opts); });

program
  .command('competitors')
  .description('Competitor intelligence summary')
  .action(competitorsCommand);

program
  .command('audit [agent]')
  .description('View audit log, optionally filter by agent')
  .option('-n, --lines <number>', 'Number of entries to show', '30')
  .action(auditCommand);

program
  .command('api')
  .description('Show API server status and endpoints')
  .action(async () => {
    const { configExists, loadConfig } = await import('../config/index.js');
    const chalk = (await import('chalk')).default;

    if (!configExists()) {
      console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
      process.exit(1);
    }

    const config = loadConfig();

    console.log(chalk.bold.cyan('\n  Hivemind API Server\n'));

    if (config.api?.enabled) {
      const port = config.api.port || 9474;
      console.log(`  Status:     ${chalk.green('Enabled')}`);
      console.log(`  Port:       ${port}`);
      console.log(`  Auth:       ${config.api.authToken ? chalk.green('Token configured') : chalk.yellow('No auth token')}`);
      console.log(chalk.bold('\n  Endpoints\n'));
      console.log('  Health');
      console.log(`  GET  /health`);
      console.log('\n  Webhooks');
      console.log(`  POST /webhooks/stripe`);
      console.log(`  POST /webhooks/razorpay`);
      console.log(`  GET  /webhooks/whatsapp (verification)`);
      console.log(`  POST /webhooks/whatsapp`);
      console.log(`  POST /webhooks/generic`);
      console.log('\n  Pipeline & Approvals');
      console.log(`  GET  /api/pipeline`);
      console.log(`  GET  /api/approvals`);
      console.log(`  POST /api/approvals/:id/approve`);
      console.log(`  POST /api/approvals/:id/reject`);
      console.log('\n  Lead Capture');
      console.log(`  POST /api/leads/capture`);
      console.log(`  POST /api/leads/import`);
      console.log('\n  Performance');
      console.log(`  GET  /api/performance`);
      console.log(`  GET  /api/exceptions`);
      console.log(`  GET  /api/briefing/latest`);
      console.log('\n  KPI');
      console.log(`  GET  /api/kpi`);
      console.log(`  GET  /api/kpi/agents`);
      console.log(`  GET  /api/kpi/pipeline`);
      console.log(`  GET  /api/kpi/financials`);
      console.log('\n  Client Portal');
      console.log(`  GET  /api/clients/:id/invoices`);
      console.log(`  GET  /api/clients/:id/contracts`);
      console.log(`  GET  /api/clients/:id/status`);
      console.log('\n  Support');
      console.log(`  POST /api/support/tickets`);
    } else {
      console.log(`  Status: ${chalk.dim('Disabled')}`);
      console.log(`  ${chalk.dim('Set api.enabled = true in config to enable.')}`);
    }

    console.log('');
  });

program
  .command('legacy-agents <action>')
  .description('Enable or disable the 15 legacy agents (full company mode)')
  .action(async (action: string) => {
    const { configExists, loadConfig, saveConfig } = await import('../config/index.js');
    const chalk = (await import('chalk')).default;

    if (!configExists()) {
      console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
      process.exit(1);
    }

    if (action !== 'enable' && action !== 'disable') {
      console.log(chalk.red(`Unknown action: ${action}. Use 'enable' or 'disable'.`));
      process.exit(1);
    }

    const config = loadConfig();
    const enabled = action === 'enable';
    config.legacyAgents = { enabled };
    saveConfig(config);

    if (enabled) {
      console.log(chalk.green('\n  Legacy agents enabled — full company mode (19 agents)'));
    } else {
      console.log(chalk.yellow('\n  Legacy agents disabled — revenue execution mode (4 agents)'));
    }
    console.log(chalk.dim('  Restart the daemon for changes to take effect: hivemind stop && hivemind start\n'));
  });

program.parse();

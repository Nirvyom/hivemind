import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

const STAGE_LABELS: Record<string, string> = {
  enquiry: 'Enquiry',
  qualified: 'Qualified',
  responded: 'Responded',
  proposal_sent: 'Proposal Sent',
  negotiating: 'Negotiating',
  won: 'Won',
  lost: 'Lost',
  dormant: 'Dormant',
};

const STAGE_COLORS: Record<string, (s: string) => string> = {
  enquiry: chalk.white,
  qualified: chalk.cyan,
  responded: chalk.blue,
  proposal_sent: chalk.yellow,
  negotiating: chalk.magenta,
  won: chalk.green,
  lost: chalk.red,
  dormant: chalk.dim,
};

export async function pipelineCommand(stage?: string): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const stages = stage
    ? [stage]
    : ['enquiry', 'qualified', 'responded', 'proposal_sent', 'negotiating', 'won', 'lost', 'dormant'];

  console.log(chalk.bold.cyan('\n  Sales Pipeline\n'));

  let totalLeads = 0;

  for (const s of stages) {
    const leads = db.prepare(
      'SELECT id, name, company, urgency, service_fit_score, budget_range, next_action, next_action_due FROM leads WHERE stage = ? ORDER BY created_at DESC'
    ).all(s) as any[];

    totalLeads += leads.length;
    const label = STAGE_LABELS[s] || s;
    const colorFn = STAGE_COLORS[s] || chalk.white;

    console.log(colorFn(`  ${label} (${leads.length})`));
    console.log('  ' + '\u2500'.repeat(60));

    if (leads.length === 0) {
      console.log(chalk.dim('    No leads'));
    } else {
      for (const lead of leads) {
        const urgencyIcon = lead.urgency === 'high' ? '\u{1f534}' : lead.urgency === 'low' ? '\u26aa' : '\u{1f7e2}';
        const score = lead.service_fit_score ? `[${lead.service_fit_score}]` : '';
        const budget = lead.budget_range ? `(${lead.budget_range})` : '';
        const overdue = lead.next_action_due && new Date(lead.next_action_due) < new Date()
          ? chalk.red(' OVERDUE')
          : '';

        console.log(`    ${urgencyIcon} #${lead.id} ${chalk.bold(lead.name)}${lead.company ? ` @ ${lead.company}` : ''} ${score} ${budget}${overdue}`);
        if (lead.next_action) {
          console.log(chalk.dim(`       Next: ${lead.next_action}${lead.next_action_due ? ` (due: ${lead.next_action_due.split('T')[0]})` : ''}`));
        }
      }
    }
    console.log('');
  }

  // Summary
  const pendingApprovals = (db.prepare(
    "SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'"
  ).get() as any).c;

  console.log(chalk.bold(`  Total: ${totalLeads} leads | Pending Approvals: ${pendingApprovals}\n`));
}

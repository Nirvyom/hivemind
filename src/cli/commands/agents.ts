import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';
import { createAgents } from '../../agents/index.js';

const REVENUE_AGENTS: Record<string, { department: string; role: string }> = {
  pipeline: { department: 'Revenue', role: 'Pipeline Manager' },
  engagement: { department: 'Revenue', role: 'Engagement Manager' },
  collections: { department: 'Revenue', role: 'Collections Manager' },
  briefing: { department: 'Revenue', role: 'Briefing Analyst' },
};

const LEGACY_AGENTS: Record<string, { department: string; role: string }> = {
  ceo: { department: 'Executive', role: 'Chief Executive Officer' },
  content: { department: 'Marketing', role: 'Content Creator' },
  social: { department: 'Marketing', role: 'Social Media Manager' },
  sales: { department: 'Sales', role: 'Sales Development Rep' },
  client: { department: 'Client Services', role: 'Account Manager' },
  ops: { department: 'Operations', role: 'Operations Manager' },
  hr: { department: 'Human Resources', role: 'HR Manager' },
  finance: { department: 'Finance', role: 'CFO' },
  legal: { department: 'Legal', role: 'General Counsel' },
  billing: { department: 'Finance', role: 'Billing Manager' },
  procurement: { department: 'Operations', role: 'Procurement Manager' },
  analytics: { department: 'Data', role: 'Analytics Manager' },
  email_campaign: { department: 'Marketing', role: 'Email Marketing Manager' },
  support: { department: 'Client Services', role: 'Support Manager' },
  competitor: { department: 'Strategy', role: 'Competitive Intelligence Analyst' },
};

const ALL_AGENT_INFO: Record<string, { department: string; role: string }> = {
  ...REVENUE_AGENTS,
  ...LEGACY_AGENTS,
};

export async function agentsCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const agentSchedules = createAgents(config);
  const activeAgentNames = new Set<string>(agentSchedules.map(s => s.agent.name));

  // Active agents
  const modeLabel = config.legacyAgents?.enabled
    ? 'Full Company Mode'
    : 'Revenue Execution OS';
  console.log(chalk.bold.cyan(`\n  Active Agents \u2014 ${modeLabel}\n`));

  console.log(
    `  ${'Status'.padEnd(8)}${'Agent'.padEnd(16)}${'Department'.padEnd(12)}${'Role'.padEnd(24)}${'Interval'.padEnd(10)}${'Last Run'.padEnd(14)}${'Runs'.padEnd(8)}${'Failed'.padEnd(8)}${'Cost'}`
  );
  console.log('  ' + '\u2500'.repeat(110));

  for (const schedule of agentSchedules) {
    const info = ALL_AGENT_INFO[schedule.agent.name] || { department: 'Unknown', role: 'Agent' };
    printAgentRow(db, schedule.agent.name, info, schedule.interval);
  }

  console.log(`\n  Total: ${agentSchedules.length} active agents`);

  // Legacy agents section: only show agents with historical runs that are NOT currently active
  const legacyWithRuns = Object.keys(LEGACY_AGENTS).filter(name => {
    if (activeAgentNames.has(name)) return false;
    const count = (db.prepare('SELECT COUNT(*) as c FROM agent_runs WHERE agent = ?').get(name) as any).c;
    return count > 0;
  });

  if (legacyWithRuns.length > 0) {
    console.log(chalk.dim('\n  Legacy Agents (not scheduled, historical data)\n'));
    for (const name of legacyWithRuns) {
      printAgentRow(db, name, LEGACY_AGENTS[name], chalk.dim('off'));
    }
  }

  console.log('');
}

function printAgentRow(
  db: any,
  name: string,
  info: { department: string; role: string },
  interval: string
): void {
  const lastRun = db.prepare(`
    SELECT status, completed_at FROM agent_runs
    WHERE agent = ? ORDER BY id DESC LIMIT 1
  `).get(name) as any;

  const totalRuns = (db.prepare(
    'SELECT COUNT(*) as c FROM agent_runs WHERE agent = ?'
  ).get(name) as any).c;

  const failedRuns = (db.prepare(
    "SELECT COUNT(*) as c FROM agent_runs WHERE agent = ? AND status = 'failed'"
  ).get(name) as any).c;

  const totalCost = (db.prepare(
    'SELECT COALESCE(SUM(cost), 0) as c FROM agent_runs WHERE agent = ?'
  ).get(name) as any).c;

  const icon = !lastRun ? '\u26aa'
    : lastRun.status === 'completed' ? '\u{1f7e2}'
    : lastRun.status === 'running' ? '\u{1f535}'
    : '\u{1f534}';

  const lastRunTime = lastRun?.completed_at ? timeSince(new Date(lastRun.completed_at)) : 'never';

  console.log(
    `  ${icon}     ${chalk.bold(name.padEnd(16))}${info.department.padEnd(12)}${info.role.padEnd(24)}${String(interval).padEnd(10)}${lastRunTime.padEnd(14)}${String(totalRuns).padEnd(8)}${String(failedRuns).padEnd(8)}$${totalCost.toFixed(4)}`
  );
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

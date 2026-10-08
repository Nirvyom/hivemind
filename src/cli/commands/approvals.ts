import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';
import { processApprovalResponse, getPendingApprovals, getApprovalById } from '../../services/approval.js';

export async function approvalsCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();

  const approvals = getPendingApprovals();

  console.log(chalk.bold.cyan(`\n  Pending Approvals (${approvals.length})\n`));

  if (approvals.length === 0) {
    console.log(chalk.dim('  No pending approvals.\n'));
    return;
  }

  console.log(
    `  ${'ID'.padEnd(6)}${'Priority'.padEnd(10)}${'Type'.padEnd(16)}${'Agent'.padEnd(14)}${'Title'.padEnd(40)}${'Created'}`
  );
  console.log('  ' + '\u2500'.repeat(100));

  for (const a of approvals) {
    const priorityLabel = a.priority === 1 ? chalk.red('URGENT')
      : a.priority === 2 ? chalk.yellow('HIGH')
      : chalk.green('NORMAL');

    const created = a.createdAt ? a.createdAt.split('T')[0] : '';

    console.log(
      `  ${String(a.id).padEnd(6)}${priorityLabel.padEnd(10 + 10)}${a.type.padEnd(16)}${a.agent.padEnd(14)}${a.title.substring(0, 38).padEnd(40)}${created}`
    );
  }

  console.log('');
}

export async function approveCommand(id: string): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();

  const approvalId = parseInt(id, 10);
  const approval = getApprovalById(approvalId);

  if (!approval) {
    console.log(chalk.red(`Approval #${id} not found.`));
    process.exit(1);
  }

  if (approval.status !== 'pending') {
    console.log(chalk.yellow(`Approval #${id} is already ${approval.status}.`));
    return;
  }

  // Show details
  console.log(chalk.bold.cyan(`\n  Approval #${id}\n`));
  console.log(`  Type:    ${approval.type}`);
  console.log(`  Agent:   ${approval.agent}`);
  console.log(`  Entity:  ${approval.entityType}${approval.entityId ? ` #${approval.entityId}` : ''}`);
  console.log(`  Title:   ${approval.title}`);
  console.log(`  Summary: ${approval.summary}`);
  if (approval.draftContent) {
    console.log(chalk.dim(`\n  Draft:\n  ${approval.draftContent.substring(0, 500).split('\n').join('\n  ')}`));
  }
  console.log('');

  await processApprovalResponse(approvalId, true, 'cli', null, config);
  console.log(chalk.green(`  Approved #${id}\n`));
}

export async function rejectCommand(id: string, note?: string): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const config = loadConfig();
  initializeDatabase();

  const approvalId = parseInt(id, 10);
  const approval = getApprovalById(approvalId);

  if (!approval) {
    console.log(chalk.red(`Approval #${id} not found.`));
    process.exit(1);
  }

  if (approval.status !== 'pending') {
    console.log(chalk.yellow(`Approval #${id} is already ${approval.status}.`));
    return;
  }

  await processApprovalResponse(approvalId, false, 'cli', note || null, config);
  console.log(chalk.red(`  Rejected #${id}${note ? ` — ${note}` : ''}\n`));
}

export async function briefingCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  const briefing = db.prepare(
    'SELECT * FROM daily_briefings ORDER BY date DESC LIMIT 1'
  ).get() as any;

  if (!briefing) {
    console.log(chalk.dim('\n  No briefing available yet.\n'));
    return;
  }

  const pipeline = JSON.parse(briefing.pipeline_summary);
  const exceptions = JSON.parse(briefing.exceptions);
  const recommendations = JSON.parse(briefing.recommendations);
  const metrics = JSON.parse(briefing.metrics);

  console.log(chalk.bold.cyan(`\n  Daily Briefing \u2014 ${briefing.date}\n`));

  // Pipeline
  console.log(chalk.bold('  Pipeline:'));
  const stages = pipeline.stages || {};
  for (const [stage, count] of Object.entries(stages)) {
    console.log(`    ${stage}: ${count}`);
  }
  console.log(`    New today: ${pipeline.newLeadsToday || 0}`);
  console.log(`    Pending approvals: ${pipeline.pendingApprovals || 0}`);

  // Metrics
  console.log(chalk.bold('\n  Metrics (30d):'));
  console.log(`    Response time: ${metrics.avgResponseTimeHours}h`);
  console.log(`    Follow-up rate: ${metrics.followUpRate}%`);
  console.log(`    Conversion: ${metrics.conversionRate}%`);
  console.log(`    Revenue: ${metrics.revenue30d}`);
  console.log(`    Proposals sent: ${metrics.proposalsSent}`);

  // Exceptions
  if (exceptions.length > 0) {
    console.log(chalk.bold('\n  Exceptions:'));
    for (const e of exceptions) {
      const color = e.severity === 'critical' ? chalk.red : e.severity === 'warning' ? chalk.yellow : chalk.dim;
      console.log(color(`    [${e.severity}] ${e.message}`));
    }
  }

  // Recommendations
  if (recommendations.length > 0) {
    console.log(chalk.bold('\n  Recommendations:'));
    for (let i = 0; i < recommendations.length; i++) {
      console.log(`    ${i + 1}. ${recommendations[i]}`);
    }
  }

  if (briefing.delivered_via) {
    console.log(chalk.dim(`\n  Delivered via ${briefing.delivered_via} at ${briefing.delivered_at || 'unknown'}`));
  }

  console.log('');
}

export async function captureCommand(opts: any): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  if (!opts.name) {
    console.log(chalk.red('  --name is required\n'));
    process.exit(1);
  }

  const result = db.prepare(`
    INSERT INTO leads (name, email, company, phone, source, channel, requirements, budget_range, urgency, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enquiry', 'new', datetime('now'), datetime('now'))
  `).run(
    opts.name,
    opts.email || null,
    opts.company || null,
    opts.phone || null,
    opts.source || 'manual',
    'manual',
    opts.requirements || null,
    opts.budget || null,
    opts.urgency || 'normal'
  );

  const leadId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, created_by)
    VALUES (?, 'note', 'inbound', 'manual', 'Lead captured via CLI', 'cli')
  `).run(leadId);

  console.log(chalk.green(`\n  Lead #${leadId} created: ${opts.name} (stage: enquiry)\n`));
}

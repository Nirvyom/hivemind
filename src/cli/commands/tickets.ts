import chalk from 'chalk';
import { configExists, loadConfig } from '../../config/index.js';
import { initializeDatabase, getSqlite } from '../../db/index.js';

export async function ticketsCommand(action: string, opts?: any): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  loadConfig();
  initializeDatabase();
  const db = getSqlite();

  switch (action) {
    case 'list':
      listTickets(db, opts);
      break;
    case 'create':
      await createTicket(db, opts);
      break;
    default:
      listTickets(db, opts);
  }
}

function listTickets(db: any, opts?: any): void {
  const status = opts?.status;
  const query = status
    ? 'SELECT st.*, c.name as client_name FROM support_tickets st LEFT JOIN clients c ON st.client_id = c.id WHERE st.status = ? ORDER BY st.priority ASC, st.created_at DESC LIMIT 20'
    : 'SELECT st.*, c.name as client_name FROM support_tickets st LEFT JOIN clients c ON st.client_id = c.id ORDER BY st.priority ASC, st.created_at DESC LIMIT 20';

  const tickets = status ? db.prepare(query).all(status) : db.prepare(query).all();

  console.log(chalk.bold.cyan('\n  Support Tickets\n'));

  if (tickets.length === 0) {
    console.log('  No tickets found.\n');
    return;
  }

  const priorityColors = [chalk.red, chalk.red, chalk.yellow, chalk.blue, chalk.dim];

  for (const ticket of tickets) {
    const pColor = priorityColors[ticket.priority - 1] || chalk.white;
    const statusColor = ticket.status === 'resolved' || ticket.status === 'closed' ? chalk.green
      : ticket.status === 'open' ? chalk.red
      : chalk.yellow;

    console.log(
      `  ${pColor(`P${ticket.priority}`)} ${chalk.bold(ticket.ticket_number)} ${statusColor(`[${ticket.status}]`)}`
    );
    console.log(`     ${ticket.subject}`);
    console.log(`     ${chalk.dim(`Client: ${ticket.client_name || 'N/A'}  Category: ${ticket.category || 'N/A'}  Created: ${ticket.created_at}`)}`);
    if (ticket.sla_deadline) {
      const slaBreached = new Date(ticket.sla_deadline) < new Date();
      console.log(`     ${slaBreached ? chalk.red('SLA BREACHED') : chalk.dim(`SLA: ${ticket.sla_deadline}`)}`);
    }
    console.log('');
  }

  // Summary
  const stats = db.prepare(
    'SELECT status, COUNT(*) as c FROM support_tickets GROUP BY status'
  ).all() as any[];

  console.log(chalk.bold('  Summary'));
  for (const stat of stats) {
    console.log(`  ${stat.status.padEnd(15)} ${stat.c}`);
  }
  console.log('');
}

async function createTicket(db: any, opts?: any): Promise<void> {
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

  db.prepare(`
    INSERT INTO support_tickets (ticket_number, subject, body, priority, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
  `).run(
    ticketNumber,
    opts?.subject || 'Manual ticket',
    opts?.body || '',
    opts?.priority || 3
  );

  console.log(chalk.green(`\n  Ticket created: ${ticketNumber}\n`));
}

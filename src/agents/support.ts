import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

export class SupportAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('support', 'Support', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'create_ticket':
            await this.createTicket(msg.payload);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.processNewTickets();
    await this.autoRespond();
    await this.checkSLABreaches();

    const stats = this.getTicketStats();
    this.sendMessage('ceo', 'report', { agent: 'support', stats });
  }

  private async createTicket(payload: any): Promise<void> {
    const db = getSqlite();
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

    db.prepare(`
      INSERT INTO support_tickets (ticket_number, client_id, subject, body, category, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
    `).run(
      ticketNumber,
      payload.clientId || null,
      payload.subject || 'No subject',
      payload.body || '',
      payload.category || null,
      payload.priority || 3
    );

    this.log.info({ ticketNumber }, 'Ticket created');
  }

  private async processNewTickets(): Promise<void> {
    const db = getSqlite();

    const newTickets = db.prepare(`
      SELECT st.*, c.name as client_name, c.company as client_company
      FROM support_tickets st
      LEFT JOIN clients c ON st.client_id = c.id
      WHERE st.status = 'open' AND st.category IS NULL
      ORDER BY st.priority ASC, st.created_at ASC
      LIMIT 10
    `).all() as any[];

    for (const ticket of newTickets) {
      try {
        const response = await this.askLLM(
          `You are a support triage agent for ${this.config.company.name}. Categorize and prioritize support tickets. Output valid JSON.`,
          `Triage this support ticket:
Subject: ${ticket.subject}
Body: ${ticket.body}
Client: ${ticket.client_name || 'Unknown'} (${ticket.client_company || 'Unknown'})

Return JSON:
{
  "category": "billing|technical|general|feature_request|bug_report",
  "priority": 1-5 (1=critical, 5=low),
  "summary": "brief summary",
  "suggestedAction": "what should be done",
  "escalate": true/false
}`,
          { json: true }
        );

        let triage: any;
        try {
          triage = JSON.parse(response.content);
        } catch {
          continue;
        }

        // Set SLA deadline based on priority
        const slaHours = triage.priority <= 1 ? 4 : triage.priority <= 2 ? 8 : triage.priority <= 3 ? 24 : 72;

        db.prepare(`
          UPDATE support_tickets SET
            category = ?,
            priority = ?,
            sla_deadline = datetime('now', '+${slaHours} hours'),
            status = 'in_progress',
            assigned_to = 'support',
            updated_at = datetime('now')
          WHERE id = ?
        `).run(triage.category, triage.priority, ticket.id);

        // Add triage note
        db.prepare(`
          INSERT INTO ticket_messages (ticket_id, sender, body, created_at)
          VALUES (?, 'system', ?, datetime('now'))
        `).run(ticket.id, `Auto-triaged: ${triage.category} (Priority ${triage.priority}). ${triage.suggestedAction}`);

        if (triage.escalate) {
          await this.escalateToFounder(ticket, triage);
        }

        this.log.info({ ticketId: ticket.id, category: triage.category, priority: triage.priority }, 'Ticket triaged');
      } catch (err: any) {
        this.log.error({ err, ticketId: ticket.id }, 'Failed to triage ticket');
      }
    }
  }

  private async autoRespond(): Promise<void> {
    const db = getSqlite();

    // Find tickets that need a response (in_progress, no agent response yet)
    const needsResponse = db.prepare(`
      SELECT st.*, c.name as client_name
      FROM support_tickets st
      LEFT JOIN clients c ON st.client_id = c.id
      WHERE st.status = 'in_progress'
      AND st.priority >= 3
      AND NOT EXISTS (
        SELECT 1 FROM ticket_messages tm
        WHERE tm.ticket_id = st.id AND tm.sender = 'agent'
      )
      ORDER BY st.priority ASC
      LIMIT 5
    `).all() as any[];

    // Gather knowledge base context
    const kbArticles = db.prepare(`
      SELECT title, content, category FROM knowledge_base
      WHERE status = 'active'
      LIMIT 20
    `).all() as any[];

    const kbContext = kbArticles.length > 0
      ? kbArticles.map(a => `[${a.category}] ${a.title}: ${a.content.slice(0, 200)}`).join('\n')
      : 'No knowledge base articles available.';

    for (const ticket of needsResponse) {
      try {
        const response = await this.askLLM(
          `You are a customer support agent for ${this.config.company.name}.
Company: ${this.config.company.description}
Services: ${this.config.company.services.join(', ')}

Knowledge Base:
${kbContext}

Respond helpfully and professionally. If you can't resolve the issue, indicate escalation is needed.`,
          `Respond to this support ticket:
Subject: ${ticket.subject}
Body: ${ticket.body}
Client: ${ticket.client_name || 'Customer'}
Category: ${ticket.category || 'general'}

Provide a helpful response.`
        );

        db.prepare(`
          INSERT INTO ticket_messages (ticket_id, sender, body, created_at)
          VALUES (?, 'agent', ?, datetime('now'))
        `).run(ticket.id, response.content);

        db.prepare(`
          UPDATE support_tickets SET status = 'waiting', updated_at = datetime('now')
          WHERE id = ?
        `).run(ticket.id);

        this.log.info({ ticketId: ticket.id }, 'Auto-response sent');
      } catch (err: any) {
        this.log.error({ err, ticketId: ticket.id }, 'Failed to auto-respond');
      }
    }
  }

  private async escalateToFounder(ticket: any, triage: any): Promise<void> {
    await notifyFounder(this.config, 'alert',
      `High-priority support ticket: [${ticket.ticket_number}] ${ticket.subject}\nClient: ${ticket.client_name || 'Unknown'}\nCategory: ${triage.category}\nPriority: ${triage.priority}\n${triage.suggestedAction}`,
      { subject: `Support Escalation: ${ticket.subject}`, urgent: true }
    ).catch(err => this.log.error({ err }, 'Failed to escalate to founder'));

    this.sendMessage('ceo', 'alert', {
      type: 'support_escalation',
      ticketNumber: ticket.ticket_number,
      subject: ticket.subject,
      priority: triage.priority,
      category: triage.category,
    }, 2);
  }

  private async checkSLABreaches(): Promise<void> {
    const db = getSqlite();

    const breaching = db.prepare(`
      SELECT st.*, c.name as client_name
      FROM support_tickets st
      LEFT JOIN clients c ON st.client_id = c.id
      WHERE st.status IN ('open', 'in_progress')
      AND st.sla_deadline IS NOT NULL
      AND st.sla_deadline <= datetime('now', '+1 hour')
      AND st.sla_deadline > datetime('now', '-24 hours')
    `).all() as any[];

    for (const ticket of breaching) {
      const isBreached = new Date(ticket.sla_deadline) <= new Date();

      this.sendMessage('ceo', 'alert', {
        type: isBreached ? 'sla_breach' : 'sla_warning',
        ticketNumber: ticket.ticket_number,
        subject: ticket.subject,
        clientName: ticket.client_name,
        slaDeadline: ticket.sla_deadline,
        priority: ticket.priority,
      }, isBreached ? 3 : 1);

      if (isBreached) {
        await notifyFounder(this.config, 'alert',
          `SLA Breach: [${ticket.ticket_number}] ${ticket.subject} — Deadline was ${ticket.sla_deadline}`,
          { subject: `SLA Breach: ${ticket.ticket_number}`, urgent: true }
        ).catch(err => this.log.error({ err }, 'Failed to notify SLA breach'));
      }
    }

    if (breaching.length > 0) {
      this.log.warn({ count: breaching.length }, 'SLA breaches detected');
    }
  }

  private getTicketStats() {
    const db = getSqlite();
    const statsByStatus = db.prepare(
      'SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status'
    ).all() as any[];
    const total = statsByStatus.reduce((s: number, t: any) => s + t.count, 0);
    return {
      total,
      byStatus: Object.fromEntries(statsByStatus.map((s: any) => [s.status, s.count])),
    };
  }
}

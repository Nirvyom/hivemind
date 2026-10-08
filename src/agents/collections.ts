import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { createApproval, getApprovedActions, markApprovalExecuted } from '../services/approval.js';
import { RazorpayService } from '../services/razorpay.js';
import type { HivemindConfig } from '../config/schema.js';

export class CollectionsAgent extends BaseAgent {
  private razorpay: RazorpayService;

  constructor(config: HivemindConfig) {
    super('collections' as any, 'Collections', config);
    this.razorpay = new RazorpayService(config);
  }

  protected async execute(_messages: AgentMessage[]): Promise<void> {
    await this.createPaymentLinks();
    await this.processApprovedPayments();
    await this.trackPaymentStatus();
    await this.sendPaymentReminders();
    await this.detectOverduePayments();
    await this.reconcilePayments();
  }

  private async createPaymentLinks(): Promise<void> {
    if (!this.razorpay.isConfigured) return;

    const db = getSqlite();

    // Find won leads without payment links
    const wonLeads = db.prepare(`
      SELECT l.*, c.id as client_id, c.email as client_email, c.contract_value
      FROM leads l
      LEFT JOIN clients c ON c.lead_id = l.id
      WHERE l.stage = 'won'
        AND l.won_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_links pl WHERE pl.lead_id = l.id AND pl.status NOT IN ('cancelled', 'expired')
        )
      LIMIT 5
    `).all() as any[];

    for (const lead of wonLeads) {
      const amount = lead.contract_value || 0;
      if (amount <= 0) continue;

      await createApproval({
        type: 'payment_link',
        entityType: 'lead',
        entityId: String(lead.id),
        agent: 'collections',
        title: `Payment link: ${lead.name} - ${this.config.defaultCurrency || 'INR'} ${amount}`,
        summary: `Create Razorpay payment link for ${lead.name}${lead.company ? ` (${lead.company})` : ''} — ${this.config.defaultCurrency || 'INR'} ${amount}`,
        actionData: {
          leadId: lead.id,
          clientId: lead.client_id,
          amount,
          currency: this.config.defaultCurrency || 'INR',
          customerEmail: lead.client_email || lead.email,
          customerName: lead.name,
          action: 'create_payment_link',
        },
        priority: 2,
      }, this.config);
    }

    // Also check unpaid invoices
    const unpaidInvoices = db.prepare(`
      SELECT i.*, c.name as client_name, c.email as client_email
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE i.status IN ('sent', 'overdue')
        AND NOT EXISTS (
          SELECT 1 FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.status NOT IN ('cancelled', 'expired')
        )
      LIMIT 5
    `).all() as any[];

    for (const invoice of unpaidInvoices) {
      await createApproval({
        type: 'payment_link',
        entityType: 'invoice',
        entityId: String(invoice.id),
        agent: 'collections',
        title: `Payment link: Invoice ${invoice.invoice_number}`,
        summary: `Create payment link for invoice ${invoice.invoice_number} — ${invoice.currency} ${invoice.total_amount}`,
        actionData: {
          invoiceId: invoice.id,
          clientId: invoice.client_id,
          amount: invoice.total_amount,
          currency: invoice.currency,
          customerEmail: invoice.client_email,
          customerName: invoice.client_name,
          action: 'create_payment_link',
        },
        priority: 2,
      }, this.config);
    }
  }

  private async processApprovedPayments(): Promise<void> {
    if (!this.razorpay.isConfigured) return;

    const db = getSqlite();
    const approved = getApprovedActions('collections');

    for (const approval of approved) {
      try {
        const actionData = approval.actionData ? JSON.parse(approval.actionData) : {};

        if (actionData.action === 'create_payment_link') {
          const amountInPaise = Math.round(actionData.amount * 100);
          const link = await this.razorpay.createPaymentLink({
            amount: amountInPaise,
            currency: actionData.currency || 'INR',
            description: approval.title,
            customer: {
              name: actionData.customerName,
              email: actionData.customerEmail,
            },
            referenceId: `hm-${actionData.leadId || actionData.invoiceId || Date.now()}`,
          });

          db.prepare(`
            INSERT INTO payment_links (lead_id, client_id, invoice_id, razorpay_link_id, razorpay_link_url, amount, currency, description, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', datetime('now'))
          `).run(
            actionData.leadId || null,
            actionData.clientId || null,
            actionData.invoiceId || null,
            link.id,
            link.short_url,
            actionData.amount,
            actionData.currency || 'INR',
            approval.title
          );

          if (actionData.leadId) {
            db.prepare(`
              INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, metadata, created_by)
              VALUES (?, 'payment_link_sent', 'outbound', 'email', 'Payment link created', ?, 'collections')
            `).run(actionData.leadId, JSON.stringify({ linkUrl: link.short_url, amount: actionData.amount }));
          }

          this.log.info({ linkId: link.id, amount: actionData.amount }, 'Payment link created');
        } else if (actionData.action === 'send_reminder') {
          // Update next reminder date
          db.prepare(`
            UPDATE payment_links SET status = 'sent' WHERE id = ?
          `).run(actionData.paymentLinkId);
        }

        markApprovalExecuted(approval.id);
      } catch (err) {
        this.log.error({ err, approvalId: approval.id }, 'Failed to process approved payment');
      }
    }
  }

  private async trackPaymentStatus(): Promise<void> {
    if (!this.razorpay.isConfigured) return;

    const db = getSqlite();
    const activeLinks = db.prepare(
      "SELECT * FROM payment_links WHERE status IN ('created', 'sent') AND razorpay_link_id IS NOT NULL"
    ).all() as any[];

    for (const link of activeLinks) {
      try {
        const rpLink = await this.razorpay.getPaymentLink(link.razorpay_link_id);

        if (rpLink.status === 'paid') {
          db.prepare(`
            UPDATE payment_links SET status = 'paid', paid_at = datetime('now') WHERE id = ?
          `).run(link.id);

          // Record transaction
          db.prepare(`
            INSERT INTO transactions (type, category, amount, currency, description, created_at)
            VALUES ('revenue', 'payment_link', ?, ?, ?, datetime('now'))
          `).run(link.amount, link.currency, `Payment via Razorpay: ${link.razorpay_link_id}`);

          // Update invoice if linked
          if (link.invoice_id) {
            db.prepare(`
              UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ?
            `).run(link.invoice_id);
          }

          this.log.info({ linkId: link.razorpay_link_id, amount: link.amount }, 'Payment received');
        } else if (rpLink.status === 'expired') {
          db.prepare("UPDATE payment_links SET status = 'expired' WHERE id = ?").run(link.id);
        } else if (rpLink.status === 'cancelled') {
          db.prepare("UPDATE payment_links SET status = 'cancelled' WHERE id = ?").run(link.id);
        }
      } catch (err) {
        this.log.error({ err, linkId: link.razorpay_link_id }, 'Failed to check payment link status');
      }
    }
  }

  private async sendPaymentReminders(): Promise<void> {
    const db = getSqlite();

    const overdueLinks = db.prepare(`
      SELECT pl.*, l.name as lead_name, l.email as lead_email
      FROM payment_links pl
      LEFT JOIN leads l ON l.id = pl.lead_id
      WHERE pl.status IN ('created', 'sent')
        AND pl.created_at < datetime('now', '-3 days')
    `).all() as any[];

    for (const link of overdueLinks) {
      await createApproval({
        type: 'follow_up',
        entityType: 'lead',
        entityId: String(link.lead_id || ''),
        agent: 'collections',
        title: `Payment reminder: ${link.lead_name || 'Client'}`,
        summary: `Reminder for unpaid link ${link.currency} ${link.amount} — ${link.razorpay_link_url}`,
        actionData: { paymentLinkId: link.id, action: 'send_reminder' },
        priority: 2,
      }, this.config);
    }
  }

  private async detectOverduePayments(): Promise<void> {
    const db = getSqlite();

    const overdue = db.prepare(`
      SELECT COUNT(*) as c FROM payment_links
      WHERE status IN ('created', 'sent')
        AND created_at < datetime('now', '-7 days')
    `).get() as any;

    if (overdue.c > 0) {
      this.log.warn({ count: overdue.c }, 'Overdue payment links detected');
    }
  }

  private async reconcilePayments(): Promise<void> {
    // Match webhook payments to invoices/payment_links
    const db = getSqlite();
    const unprocessedEvents = db.prepare(`
      SELECT * FROM webhook_events
      WHERE source = 'razorpay' AND status = 'pending'
      ORDER BY created_at ASC LIMIT 20
    `).all() as any[];

    for (const event of unprocessedEvents) {
      try {
        const payload = JSON.parse(event.payload);
        const eventType = payload.event;

        if (eventType === 'payment_link.paid') {
          const linkId = payload.payload?.payment_link?.entity?.id;
          if (linkId) {
            db.prepare(`
              UPDATE payment_links SET status = 'paid', paid_at = datetime('now'),
                razorpay_payment_id = ?
              WHERE razorpay_link_id = ?
            `).run(payload.payload?.payment?.entity?.id || null, linkId);

            const link = db.prepare('SELECT * FROM payment_links WHERE razorpay_link_id = ?').get(linkId) as any;
            if (link) {
              db.prepare(`
                INSERT INTO transactions (type, category, amount, currency, description, created_at)
                VALUES ('revenue', 'payment_link', ?, ?, ?, datetime('now'))
              `).run(link.amount, link.currency, `Razorpay webhook payment: ${linkId}`);
            }
          }
        }

        db.prepare(`
          UPDATE webhook_events SET status = 'processed', processed_by = 'collections', processed_at = datetime('now')
          WHERE id = ?
        `).run(event.id);
      } catch (err) {
        this.log.error({ err, eventId: event.id }, 'Failed to reconcile payment');
      }
    }
  }
}

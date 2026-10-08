import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

export class BillingAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('billing', 'Billing', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'create_invoice':
            await this.createInvoice(msg.payload);
            break;
          case 'create_subscription':
            await this.createSubscription(msg.payload);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.processRecurringBilling();
    await this.checkOverdueInvoices();
    await this.syncPaymentStatus();

    // Report to Finance
    const billingStats = this.getBillingStats();
    this.sendMessage('finance', 'report', { agent: 'billing', ...billingStats });
    this.sendMessage('ceo', 'report', { agent: 'billing', ...billingStats });
  }

  private generateInvoiceNumber(): string {
    const now = new Date();
    const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const db = getSqlite();
    const count = (db.prepare("SELECT COUNT(*) as count FROM invoices WHERE invoice_number LIKE ?").get(`${prefix}%`) as any).count;
    return `${prefix}-${String(count + 1).padStart(4, '0')}`;
  }

  async createInvoice(payload: any): Promise<void> {
    const { clientId, amount, description, productName, lineItems: providedLineItems } = payload;
    const db = getSqlite();

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
    if (!client) {
      this.log.warn({ clientId }, 'Client not found for invoice');
      return;
    }

    // Build line items from product catalog if available
    let invoiceAmount = amount || 0;
    let lineItems = providedLineItems || [];

    if (productName && lineItems.length === 0) {
      const product = (this.config.products || []).find(p => p.name === productName && p.active);
      if (product && product.pricing.length > 0) {
        const tier = product.pricing[0];
        invoiceAmount = invoiceAmount || tier.price;
        lineItems = [{
          description: `${product.name} — ${tier.name} (${tier.billingCycle})`,
          quantity: 1,
          unitPrice: tier.price,
          amount: tier.price,
        }];
      }
    }

    if (lineItems.length === 0) {
      lineItems = [{ description: description || 'Services', quantity: 1, unitPrice: invoiceAmount, amount: invoiceAmount }];
    }

    const totalAmount = lineItems.reduce((sum: number, item: any) => sum + (item.amount || 0), 0) || invoiceAmount;
    const invoiceNumber = this.generateInvoiceNumber();

    // Insert invoice
    const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO invoices (invoice_number, client_id, amount, tax_amount, total_amount, currency, status, due_date, line_items, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, 'USD', 'draft', ?, ?, datetime('now'), datetime('now'))
    `).run(invoiceNumber, clientId, totalAmount, totalAmount, dueDate, JSON.stringify(lineItems));

    this.log.info({ invoiceNumber, clientId, amount: totalAmount }, 'Invoice created');

    // Create Stripe invoice if configured
    if (this.config.stripe?.secretKey) {
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(this.config.stripe.secretKey);

        let customerId = client.stripe_customer_id;
        if (!customerId) {
          const customer = await stripe.customers.create({
            name: client.name,
            email: client.email,
            metadata: { hivemindClientId: String(clientId) },
          });
          customerId = customer.id;
          db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run(customerId, clientId);
        }

        const stripeInvoice = await stripe.invoices.create({ customer: customerId, auto_advance: true });

        for (const item of lineItems) {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: stripeInvoice.id,
            amount: Math.round((item.amount || 0) * 100),
            currency: 'usd',
            description: item.description,
          });
        }

        await stripe.invoices.finalizeInvoice(stripeInvoice.id);

        db.prepare(`
          UPDATE invoices SET stripe_invoice_id = ?, status = 'sent', sent_at = datetime('now'), updated_at = datetime('now')
          WHERE invoice_number = ?
        `).run(stripeInvoice.id, invoiceNumber);

        // Record transaction
        db.prepare(`
          INSERT INTO transactions (type, category, amount, description, stripe_invoice_id, client_id, created_at)
          VALUES ('revenue', 'invoice_payment', ?, ?, ?, ?, datetime('now'))
        `).run(totalAmount, description || invoiceNumber, stripeInvoice.id, clientId);

        this.log.info({ invoiceNumber, stripeId: stripeInvoice.id }, 'Stripe invoice created');
      } catch (err: any) {
        this.log.error({ err }, 'Failed to create Stripe invoice');
        this.sendMessage('ops', 'alert', { type: 'invoice_failure', error: err.message, clientId }, 2);
      }
    }
  }

  private async createSubscription(payload: any): Promise<void> {
    const { clientId, productName, tierName, amount, billingCycle } = payload;
    const db = getSqlite();

    const startDate = new Date().toISOString().split('T')[0];
    const nextBilling = this.getNextBillingDate(billingCycle || 'monthly');

    db.prepare(`
      INSERT INTO subscriptions (client_id, product_name, tier_name, amount, billing_cycle, status, start_date, next_billing_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))
    `).run(clientId, productName, tierName, amount, billingCycle || 'monthly', startDate, nextBilling);

    this.log.info({ clientId, productName, amount }, 'Subscription created');
  }

  private async processRecurringBilling(): Promise<void> {
    const db = getSqlite();
    const today = new Date().toISOString().split('T')[0];

    const due = db.prepare(`
      SELECT * FROM subscriptions
      WHERE status = 'active' AND next_billing_date <= ?
    `).all(today) as any[];

    for (const sub of due) {
      await this.createInvoice({
        clientId: sub.client_id,
        amount: sub.amount,
        productName: sub.product_name,
        description: `${sub.product_name} — ${sub.tier_name || 'Standard'} (${sub.billing_cycle})`,
      });

      const nextBilling = this.getNextBillingDate(sub.billing_cycle);
      db.prepare(`
        UPDATE subscriptions SET next_billing_date = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextBilling, sub.id);

      this.log.info({ subscription: sub.id, product: sub.product_name }, 'Recurring invoice generated');
    }
  }

  private async checkOverdueInvoices(): Promise<void> {
    const db = getSqlite();
    const today = new Date().toISOString().split('T')[0];

    const overdue = db.prepare(`
      SELECT i.*, c.name as client_name, c.email as client_email
      FROM invoices i
      JOIN clients c ON i.client_id = c.id
      WHERE i.status = 'sent' AND i.due_date < ?
    `).all(today) as any[];

    for (const invoice of overdue) {
      db.prepare("UPDATE invoices SET status = 'overdue', updated_at = datetime('now') WHERE id = ?").run(invoice.id);

      if (invoice.reminder_count >= 3) {
        // Escalate to CEO
        this.sendMessage('ceo', 'alert', {
          type: 'collection_escalation',
          invoiceNumber: invoice.invoice_number,
          clientName: invoice.client_name,
          amount: invoice.total_amount,
          message: `Invoice ${invoice.invoice_number} for ${invoice.client_name} ($${invoice.total_amount}) is overdue after 3 reminders.`,
        }, 2);

        await notifyFounder(this.config, 'alert',
          `Overdue invoice escalation: ${invoice.invoice_number} for ${invoice.client_name} ($${invoice.total_amount}). 3 reminders sent.`,
          { subject: `Overdue: ${invoice.invoice_number}` }
        ).catch(() => {});
      } else {
        db.prepare(`
          UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(invoice.id);

        // Queue reminder email
        if (invoice.client_email) {
          this.sendMessage('client', 'task', {
            type: 'send_email',
            to: invoice.client_email,
            subject: `Payment Reminder: Invoice ${invoice.invoice_number}`,
            body: `This is a friendly reminder that invoice ${invoice.invoice_number} for $${invoice.total_amount} is past due. Please arrange payment at your earliest convenience.`,
          });
        }
      }
    }

    if (overdue.length > 0) {
      this.log.warn({ count: overdue.length }, 'Overdue invoices processed');
    }
  }

  private async syncPaymentStatus(): Promise<void> {
    if (!this.config.stripe?.secretKey) return;

    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(this.config.stripe.secretKey);
      const db = getSqlite();

      const openInvoices = db.prepare(`
        SELECT * FROM invoices WHERE stripe_invoice_id IS NOT NULL AND status IN ('sent', 'overdue')
      `).all() as any[];

      for (const inv of openInvoices) {
        try {
          const stripeInv = await stripe.invoices.retrieve(inv.stripe_invoice_id);
          if (stripeInv.status === 'paid') {
            db.prepare(`
              UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ?
            `).run(inv.id);

            // Record payment
            db.prepare(`
              INSERT INTO payment_records (invoice_id, client_id, amount, currency, payment_method, status, stripe_payment_id, paid_at, created_at)
              VALUES (?, ?, ?, 'USD', 'stripe', 'completed', ?, datetime('now'), datetime('now'))
            `).run(inv.id, inv.client_id, inv.total_amount, stripeInv.payment_intent as string || null);

            this.log.info({ invoiceNumber: inv.invoice_number }, 'Payment received');
          }
        } catch (err: any) {
          this.log.debug({ err, invoice: inv.invoice_number }, 'Failed to check invoice status');
        }
      }
    } catch (err: any) {
      this.log.debug({ err }, 'Failed to sync payments');
    }
  }

  private getNextBillingDate(cycle: string): string {
    const now = new Date();
    switch (cycle) {
      case 'monthly': now.setMonth(now.getMonth() + 1); break;
      case 'quarterly': now.setMonth(now.getMonth() + 3); break;
      case 'yearly': now.setFullYear(now.getFullYear() + 1); break;
      default: now.setMonth(now.getMonth() + 1);
    }
    return now.toISOString().split('T')[0];
  }

  private getBillingStats() {
    const db = getSqlite();
    const totalInvoiced = (db.prepare("SELECT COALESCE(SUM(total_amount), 0) as total FROM invoices").get() as any).total;
    const totalCollected = (db.prepare("SELECT COALESCE(SUM(total_amount), 0) as total FROM invoices WHERE status = 'paid'").get() as any).total;
    const outstanding = (db.prepare("SELECT COALESCE(SUM(total_amount), 0) as total FROM invoices WHERE status IN ('sent', 'overdue')").get() as any).total;
    const mrr = (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'").get() as any).total;
    const overdueCount = (db.prepare("SELECT COUNT(*) as count FROM invoices WHERE status = 'overdue'").get() as any).count;

    return { totalInvoiced, totalCollected, outstanding, mrr, overdueCount };
  }
}

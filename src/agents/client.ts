import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class ClientAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('client', 'Client', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    const tasks = messages.filter(m => m.type === 'task');

    for (const task of tasks) {
      switch (task.payload.type) {
        case 'create_proposal':
          await this.createProposal(task.payload);
          break;
        case 'create_invoice':
          await this.createInvoice(task.payload);
          break;
        case 'send_email':
          await this.sendEmail(task.payload);
          break;
      }
      this.markMessageProcessed(task.id);
    }

    // Check for qualified leads to convert
    await this.checkQualifiedLeads();

    // Check for pending invoices
    await this.checkPendingInvoices();

    // Report
    const stats = this.getClientStats();
    this.sendMessage('ceo', 'report', { agent: 'client', stats });
  }

  private getProductCatalogContext(): string {
    const products = (this.config.products || []).filter(p => p.active);
    if (products.length === 0) return '';

    return products.map(p => {
      const tiers = p.pricing.map(t =>
        `  - ${t.name}: $${t.price}/${t.billingCycle} (${t.features.join(', ')})`
      ).join('\n');
      return `${p.name}: ${p.description}\n  Deliverables: ${p.deliverables.join(', ')}\n  Pricing:\n${tiers}`;
    }).join('\n\n');
  }

  private getSenderAddress(): string {
    if (this.config.companyEmail?.address) return this.config.companyEmail.address;
    if (this.config.email?.fromAddress) return this.config.email.fromAddress;
    return 'noreply@example.com';
  }

  private async createProposal(payload: any): Promise<void> {
    const { leadId } = payload;
    const db = getSqlite();

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead) return;

    const productCatalog = this.getProductCatalogContext();
    const notes = lead.notes ? JSON.parse(lead.notes) : {};
    const recommendedProduct = notes.recommendedProduct;

    const systemPrompt = `You are a business development manager for ${this.config.company.name}.
Company: ${this.config.company.description}
Services: ${this.config.company.services.join(', ')}

${productCatalog ? `PRODUCT CATALOG:\n${productCatalog}\n\nBase your proposal on actual products from the catalog. Use real pricing tiers and deliverables.` : ''}

Generate a professional project proposal. Output valid JSON.`;

    const userPrompt = `Create a proposal for:
Client: ${lead.name} at ${lead.company || 'their company'}
Pain points: ${notes.painPoints?.join(', ') || 'general business needs'}
${recommendedProduct ? `Recommended product: ${recommendedProduct}` : `Our services: ${this.config.company.services.join(', ')}`}

Return JSON:
{
  "title": "Proposal title",
  "summary": "Executive summary referencing specific products",
  "scope": ["deliverable 1 from product catalog", "deliverable 2"],
  "timeline": "estimated timeline",
  "pricing": {
    "total": 0,
    "breakdown": [{"item": "product/tier name", "amount": 0}]
  },
  "terms": "payment terms"
}`;

    try {
      const response = await this.askLLM(systemPrompt, userPrompt, { json: true });
      let proposal: any;
      try {
        proposal = JSON.parse(response.content);
      } catch {
        this.log.warn('Failed to parse proposal');
        return;
      }

      // Update lead with proposal
      db.prepare(`
        UPDATE leads SET status = 'proposal',
        notes = json_set(COALESCE(notes, '{}'), '$.proposal', ?),
        updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(proposal), leadId);

      this.log.info({ lead: lead.name, value: proposal.pricing?.total }, 'Proposal created');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to create proposal');
    }
  }

  private async createInvoice(payload: any): Promise<void> {
    const { clientId, amount, description, productName } = payload;

    if (!this.config.stripe?.secretKey) {
      this.log.warn('Stripe not configured, skipping invoice creation');
      return;
    }

    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(this.config.stripe.secretKey);

      const db = getSqlite();
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
      if (!client) return;

      // Determine actual pricing from product catalog if productName is provided
      let invoiceAmount = amount;
      let invoiceDescription = description;

      if (productName) {
        const product = (this.config.products || []).find(p => p.name === productName && p.active);
        if (product && product.pricing.length > 0) {
          const tier = product.pricing[0]; // default to first tier
          invoiceAmount = invoiceAmount || tier.price;
          invoiceDescription = invoiceDescription || `${product.name} — ${tier.name} (${tier.billingCycle})`;
        }
      }

      // Create or get Stripe customer
      let customerId = client.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: client.name,
          email: client.email,
          metadata: { hivemindClientId: String(clientId) },
        });
        customerId = customer.id;

        db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?')
          .run(customerId, clientId);
      }

      // Create invoice
      const invoice = await stripe.invoices.create({
        customer: customerId,
        auto_advance: true,
      });

      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
        amount: Math.round(invoiceAmount * 100),
        currency: 'usd',
        description: invoiceDescription || `Services - ${this.config.company.name}`,
      });

      const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

      // Record transaction
      db.prepare(`
        INSERT INTO transactions (type, category, amount, description, stripe_invoice_id, client_id, created_at)
        VALUES ('revenue', 'invoice_payment', ?, ?, ?, ?, datetime('now'))
      `).run(invoiceAmount, invoiceDescription, invoice.id, clientId);

      this.log.info({ clientId, amount: invoiceAmount, invoiceId: invoice.id }, 'Invoice created');

      // Send invoice URL to client
      if (finalizedInvoice.hosted_invoice_url) {
        this.log.info({ url: finalizedInvoice.hosted_invoice_url }, 'Invoice URL generated');
      }
    } catch (err: any) {
      this.log.error({ err }, 'Failed to create Stripe invoice');
      this.sendMessage('ops', 'alert', {
        type: 'invoice_failure',
        error: err.message,
        clientId,
      }, 2);
    }
  }

  private async sendEmail(payload: any): Promise<void> {
    const { to, subject, body } = payload;
    if (!to || (!this.config.email?.provider && !this.config.companyEmail)) {
      this.log.debug('Email not configured or no recipient');
      return;
    }

    const fromAddress = this.getSenderAddress();

    try {
      if (this.config.email?.provider === 'resend') {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.email.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromAddress,
            to,
            subject,
            text: body,
          }),
        });

        if (!response.ok) {
          throw new Error(`Resend error: ${response.status}`);
        }

        this.log.info({ to, subject, from: fromAddress }, 'Email sent via Resend');
      }
      // Gmail SMTP would require nodemailer — kept as placeholder
    } catch (err: any) {
      this.log.error({ err, to }, 'Failed to send email');
    }
  }

  private async checkQualifiedLeads(): Promise<void> {
    const db = getSqlite();
    const qualified = db.prepare(`
      SELECT * FROM leads WHERE status = 'qualified' ORDER BY score DESC LIMIT 3
    `).all() as any[];

    for (const lead of qualified) {
      await this.createProposal({ leadId: lead.id });
    }
  }

  private async checkPendingInvoices(): Promise<void> {
    if (!this.config.stripe?.secretKey) return;

    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(this.config.stripe.secretKey);

      const invoices = await stripe.invoices.list({
        status: 'open',
        limit: 10,
      });

      for (const invoice of invoices.data) {
        if (invoice.status === 'paid') {
          const db = getSqlite();
          db.prepare(`
            UPDATE transactions SET type = 'revenue' WHERE stripe_invoice_id = ?
          `).run(invoice.id);
        }
      }
    } catch (err: any) {
      this.log.debug({ err }, 'Failed to check invoices');
    }
  }

  private getClientStats() {
    const db = getSqlite();
    const clientCount = (db.prepare('SELECT COUNT(*) as count FROM clients').get() as any).count;
    const revenue = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
    ).get() as any).total;
    return { clients: clientCount, totalRevenue: revenue };
  }
}

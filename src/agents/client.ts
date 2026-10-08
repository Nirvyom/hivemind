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
          // Forward to Billing agent
          this.sendMessage('billing', 'task', { ...task.payload }, 1);
          break;
        case 'review_result':
          await this.handleLegalReview(task.payload);
          break;
        case 'contract_ready':
          await this.handleContractReady(task.payload);
          break;
        case 'send_email':
          await this.sendEmail(task.payload);
          break;
      }
      this.markMessageProcessed(task.id);
    }

    // Check for qualified leads to convert
    await this.checkQualifiedLeads();

    // Onboard won leads
    await this.checkWonLeads();

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

      // Send proposal to Legal for review
      this.sendMessage('legal', 'task', {
        type: 'review_proposal',
        leadId,
        proposal,
      }, 1);

      this.log.info({ lead: lead.name, value: proposal.pricing?.total }, 'Proposal created, sent to Legal for review');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to create proposal');
    }
  }

  private async handleLegalReview(payload: any): Promise<void> {
    const { leadId, approved, riskLevel, issues, recommendations, requiredClauses } = payload;
    const db = getSqlite();

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead) return;

    if (approved) {
      // Request contract generation from Legal
      const notes = lead.notes ? JSON.parse(lead.notes) : {};
      this.sendMessage('legal', 'task', {
        type: 'generate_contract',
        leadId,
        clientName: lead.name,
        clientCompany: lead.company,
        proposal: notes.proposal,
      }, 1);

      db.prepare(`
        UPDATE leads SET notes = json_set(COALESCE(notes, '{}'), '$.legalApproved', 1, '$.riskLevel', ?),
        updated_at = datetime('now') WHERE id = ?
      `).run(riskLevel, leadId);

      this.log.info({ leadId, riskLevel }, 'Proposal approved by Legal, contract requested');
    } else {
      this.log.warn({ leadId, issues }, 'Proposal flagged by Legal');

      db.prepare(`
        UPDATE leads SET notes = json_set(COALESCE(notes, '{}'), '$.legalIssues', ?, '$.riskLevel', ?),
        updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(issues), riskLevel, leadId);
    }
  }

  private async handleContractReady(payload: any): Promise<void> {
    const { leadId, contractTitle, keyTerms } = payload;
    const db = getSqlite();

    db.prepare(`
      UPDATE leads SET status = 'contract',
      notes = json_set(COALESCE(notes, '{}'), '$.contractTitle', ?, '$.keyTerms', ?),
      updated_at = datetime('now') WHERE id = ?
    `).run(contractTitle, JSON.stringify(keyTerms), leadId);

    this.log.info({ leadId, contractTitle }, 'Contract ready for client');
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

  private async checkWonLeads(): Promise<void> {
    const db = getSqlite();
    const wonLeads = db.prepare(`
      SELECT id FROM leads
      WHERE status = 'closed_won'
      AND id NOT IN (SELECT COALESCE(lead_id, 0) FROM clients)
    `).all() as any[];

    for (const lead of wonLeads) {
      await this.onboardClient(lead.id);
    }
  }

  async onboardClient(leadId: number): Promise<void> {
    const db = getSqlite();

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead) {
      this.log.warn({ leadId }, 'Lead not found for onboarding');
      return;
    }

    // Check if client already exists for this lead
    const existingClient = db.prepare('SELECT id FROM clients WHERE lead_id = ?').get(leadId);
    if (existingClient) {
      this.log.info({ leadId }, 'Client already exists for this lead');
      return;
    }

    const notes = lead.notes ? JSON.parse(lead.notes) : {};

    // 1. Create client record from lead data
    const result = db.prepare(`
      INSERT INTO clients (lead_id, name, email, company, contract_value, status, signed_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `).run(
      lead.id,
      lead.name,
      lead.email || 'unknown@example.com',
      lead.company || null,
      notes.proposal?.pricing?.total || 0
    );

    const clientId = Number(result.lastInsertRowid);

    // Update lead status
    db.prepare(`
      UPDATE leads SET status = 'closed_won', updated_at = datetime('now') WHERE id = ?
    `).run(leadId);

    // 2. Send welcome email sequence (via Email Campaign agent)
    this.sendMessage('email_campaign', 'task', {
      type: 'send_welcome',
      clientId,
      clientName: lead.name,
      clientEmail: lead.email,
    });

    // 3. Generate NDA (via Legal)
    this.sendMessage('legal', 'task', {
      type: 'generate_nda',
      clientId,
      clientName: lead.name,
      clientCompany: lead.company,
    });

    // 4. Create subscription (via Billing)
    this.sendMessage('billing', 'task', {
      type: 'create_subscription',
      clientId,
      clientName: lead.name,
      product: notes.recommendedProduct,
      value: notes.proposal?.pricing?.total || 0,
    });

    // 5. Notify CEO + founder
    this.sendMessage('ceo', 'report', {
      type: 'new_client',
      clientId,
      clientName: lead.name,
      company: lead.company,
      value: notes.proposal?.pricing?.total || 0,
    }, 2);

    // 6. Log in audit trail
    this.audit('client_onboarded', 'client', clientId, {
      leadId,
      clientName: lead.name,
      company: lead.company,
      value: notes.proposal?.pricing?.total || 0,
    });

    this.log.info({ clientId, clientName: lead.name, leadId }, 'Client onboarded');
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

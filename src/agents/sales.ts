import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

export class SalesAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('sales', 'Sales', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    const tasks = messages.filter(m => m.type === 'task');

    for (const task of tasks) {
      if (task.payload.type === 'execute_sales') {
        await this.executeSalesDirectives(task.payload.directives);
      }
      this.markMessageProcessed(task.id);
    }

    // Autonomous: follow up on existing leads
    await this.followUpLeads();

    // Analyze upsell opportunities
    await this.analyzeUpsellOpportunities();

    // Report to CEO
    const stats = this.getLeadStats();
    this.sendMessage('ceo', 'report', { agent: 'sales', stats });
  }

  private getProductCatalogContext(): string {
    const products = (this.config.products || []).filter(p => p.active);
    if (products.length === 0) return 'No structured products — use services list.';

    return products.map(p => {
      const tiers = p.pricing.map(t =>
        `  - ${t.name}: $${t.price}/${t.billingCycle} (${t.features.join(', ')})`
      ).join('\n');
      return `${p.name}: ${p.description}\n  Deliverables: ${p.deliverables.join(', ')}\n  Pricing:\n${tiers}`;
    }).join('\n\n');
  }

  private async executeSalesDirectives(directives: any[]): Promise<void> {
    for (const directive of directives) {
      if (directive.action === 'identify_leads' || directive.action === 'prospect') {
        await this.generateProspects(directive.target, directive.product);
      } else if (directive.action === 'outreach') {
        await this.generateOutreach(directive.target, directive.product);
      }
    }
  }

  private async generateProspects(target: string, product?: string): Promise<void> {
    const productContext = this.getProductCatalogContext();

    const systemPrompt = `You are a B2B sales agent for ${this.config.company.name}.
Company: ${this.config.company.description}
Services: ${this.config.company.services.join(', ')}
Target audience: ${this.config.company.targetAudience || target}

PRODUCT CATALOG:
${productContext}

${product ? `Focus on finding prospects for: ${product}` : ''}

Generate realistic prospect profiles. Output valid JSON only.`;

    const userPrompt = `Generate 5 ideal customer prospect profiles for outreach targeting: ${target}
${product ? `These prospects should be ideal buyers for "${product}".` : ''}

Return JSON:
{
  "prospects": [
    {
      "name": "Contact Name",
      "company": "Company Name",
      "title": "Job Title",
      "email": "likely email format",
      "linkedinUrl": "linkedin profile URL pattern",
      "painPoints": ["relevant pain point"],
      "score": 1-100,
      "recommendedProduct": "which product/tier to pitch",
      "approachStrategy": "how to approach them, referencing specific product value"
    }
  ]
}`;

    try {
      const response = await this.askLLM(systemPrompt, userPrompt, { json: true });
      let data: any;
      try {
        data = JSON.parse(response.content);
      } catch {
        this.log.warn('Failed to parse prospect JSON');
        return;
      }

      const db = getSqlite();
      for (const prospect of data.prospects || []) {
        db.prepare(`
          INSERT INTO leads (name, email, company, linkedin_url, source, status, score, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'outbound', 'new', ?, ?, datetime('now'), datetime('now'))
        `).run(
          prospect.name,
          prospect.email || null,
          prospect.company || null,
          prospect.linkedinUrl || null,
          prospect.score || 50,
          JSON.stringify({
            title: prospect.title,
            painPoints: prospect.painPoints,
            approachStrategy: prospect.approachStrategy,
            recommendedProduct: prospect.recommendedProduct,
          }),
        );

        // Notify founder about high-score leads
        if ((prospect.score || 0) >= 80) {
          await notifyFounder(this.config, 'alert',
            `High-score lead identified: ${prospect.name} at ${prospect.company} (score: ${prospect.score}). Recommended product: ${prospect.recommendedProduct || 'N/A'}`,
            { subject: `High-Score Lead: ${prospect.name}` }
          ).catch(err => this.log.error({ err }, 'Failed to notify founder about lead'));
        }
      }

      this.log.info({ count: data.prospects?.length || 0 }, 'Prospects generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate prospects');
    }
  }

  private async generateOutreach(target: string, product?: string): Promise<void> {
    const db = getSqlite();
    const newLeads = db.prepare(`
      SELECT * FROM leads WHERE status = 'new' ORDER BY score DESC LIMIT 5
    `).all() as any[];

    const productContext = this.getProductCatalogContext();

    for (const lead of newLeads) {
      const notes = lead.notes ? JSON.parse(lead.notes) : {};
      const recommendedProduct = notes.recommendedProduct || product;

      const systemPrompt = `You are a sales professional for ${this.config.company.name}.
Company: ${this.config.company.description}
Services: ${this.config.company.services.join(', ')}
Brand voice: ${this.config.brand.voiceTone}

PRODUCT CATALOG:
${productContext}

Write a personalized outreach message. Reference specific product pricing and deliverables
when relevant. Be genuine, not pushy. Output valid JSON.`;

      const userPrompt = `Write a personalized outreach email for:
Name: ${lead.name}
Company: ${lead.company || 'Unknown'}
Title: ${notes.title || 'Unknown'}
Pain points: ${notes.painPoints?.join(', ') || 'Unknown'}
Approach: ${notes.approachStrategy || 'Standard'}
${recommendedProduct ? `Recommended product to pitch: ${recommendedProduct}` : ''}

Return JSON:
{
  "subject": "email subject",
  "body": "email body (plain text, professional but warm, mention specific product and pricing)",
  "followUpDays": 3
}`;

      try {
        const response = await this.askLLM(systemPrompt, userPrompt, { json: true });
        let outreach: any;
        try {
          outreach = JSON.parse(response.content);
        } catch {
          continue;
        }

        // Update lead status
        db.prepare(`
          UPDATE leads SET status = 'contacted', last_contacted_at = datetime('now'),
          notes = json_set(COALESCE(notes, '{}'), '$.outreachSubject', ?, '$.outreachBody', ?)
          WHERE id = ?
        `).run(outreach.subject, outreach.body, lead.id);

        // If email integration is configured, queue the email
        if (this.config.email?.provider || this.config.companyEmail) {
          this.sendMessage('client', 'task', {
            type: 'send_email',
            to: lead.email,
            subject: outreach.subject,
            body: outreach.body,
            leadId: lead.id,
          });
        }

        this.log.info({ lead: lead.name }, 'Outreach generated');
      } catch (err: any) {
        this.log.error({ err, lead: lead.name }, 'Failed to generate outreach');
      }
    }
  }

  private async followUpLeads(): Promise<void> {
    const db = getSqlite();
    const staleLeads = db.prepare(`
      SELECT * FROM leads
      WHERE status = 'contacted'
        AND last_contacted_at < datetime('now', '-3 days')
      ORDER BY score DESC
      LIMIT 3
    `).all() as any[];

    for (const lead of staleLeads) {
      this.log.info({ lead: lead.name }, 'Follow-up needed');

      db.prepare(`
        UPDATE leads SET updated_at = datetime('now') WHERE id = ?
      `).run(lead.id);
    }
  }

  async analyzeUpsellOpportunities(): Promise<void> {
    const db = getSqlite();

    // Find active subscriptions on lower tiers or nearing usage limits
    const activeSubscriptions = db.prepare(`
      SELECT s.*, c.name as client_name, c.email as client_email, c.id as client_id
      FROM subscriptions s
      JOIN clients c ON s.client_id = c.id
      WHERE s.status = 'active'
      ORDER BY s.amount ASC
    `).all() as any[];

    if (activeSubscriptions.length === 0) return;

    const productCatalog = this.getProductCatalogContext();

    try {
      const response = await this.askLLM(
        `You are a sales analyst for ${this.config.company.name}. Analyze subscriptions and recommend upsell opportunities. Output valid JSON.`,
        `Current active subscriptions:
${activeSubscriptions.map(s => `- ${s.client_name}: ${s.product_name} (${s.tier_name || 'default'}) at $${s.amount}/${s.billing_cycle}`).join('\n')}

Product catalog:
${productCatalog}

Return JSON:
{
  "opportunities": [
    {
      "clientName": "name",
      "clientId": 0,
      "currentProduct": "current",
      "currentAmount": 0,
      "suggestedUpgrade": "product/tier name",
      "suggestedAmount": 0,
      "reason": "why this client would benefit",
      "confidence": "high|medium|low"
    }
  ]
}`,
        { json: true }
      );

      let data: any;
      try {
        data = JSON.parse(response.content);
      } catch {
        return;
      }

      for (const opp of data.opportunities || []) {
        if (opp.confidence === 'high' || opp.confidence === 'medium') {
          this.sendMessage('client', 'task', {
            type: 'upsell_outreach',
            clientId: opp.clientId,
            clientName: opp.clientName,
            currentProduct: opp.currentProduct,
            suggestedUpgrade: opp.suggestedUpgrade,
            reason: opp.reason,
          });
        }
      }

      this.log.info({ opportunities: data.opportunities?.length || 0 }, 'Upsell opportunities analyzed');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to analyze upsell opportunities');
    }
  }

  createLeadWithReferral(
    leadData: { name: string; email?: string; company?: string; source: string },
    referrerClientId: number
  ): void {
    const db = getSqlite();

    const result = db.prepare(`
      INSERT INTO leads (name, email, company, source, status, score, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'new', 60, ?, datetime('now'), datetime('now'))
    `).run(
      leadData.name,
      leadData.email || null,
      leadData.company || null,
      leadData.source || 'referral',
      JSON.stringify({ referredBy: referrerClientId })
    );

    const leadId = Number(result.lastInsertRowid);

    db.prepare(`
      INSERT INTO referrals (referrer_client_id, referred_lead_id, status, created_at)
      VALUES (?, ?, 'pending', datetime('now'))
    `).run(referrerClientId, leadId);

    this.log.info({ leadId, referrerClientId }, 'Referral lead created');
  }

  private getLeadStats() {
    const db = getSqlite();
    const stats = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status
    `).all() as any[];
    return Object.fromEntries(stats.map(s => [s.status, s.count]));
  }
}

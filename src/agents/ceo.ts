import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { notifyFounder } from '../services/notify.js';
import type { HivemindConfig } from '../config/schema.js';

export class CEOAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('ceo', 'CEO', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    // Process reports from other agents
    const reports = messages.filter(m => m.type === 'report');
    const alerts = messages.filter(m => m.type === 'alert');

    // Handle urgent alerts first
    for (const alert of alerts) {
      this.log.warn({ from: alert.fromAgent, payload: alert.payload }, 'Processing alert');
      this.markMessageProcessed(alert.id);
    }

    // Generate or update weekly strategy
    const strategy = await this.generateStrategy(reports);

    // Dispatch tasks to other agents
    await this.dispatchTasks(strategy);

    // Send weekly digest to founder
    await this.sendFounderDigest(strategy, reports);

    // Write strategy to Notion if configured
    await this.writeStrategyToNotion(strategy);

    // Mark reports processed
    for (const report of reports) {
      this.markMessageProcessed(report.id);
    }
  }

  private getProductCatalogContext(): string {
    const products = this.config.products || [];
    if (products.length === 0) return 'No products defined yet.';

    return products.filter(p => p.active).map(p => {
      const tiers = p.pricing.map(t => `${t.name}: $${t.price}/${t.billingCycle}`).join(', ');
      return `- ${p.name} (${p.category || 'general'}): ${p.description}\n  Pricing: ${tiers || 'Custom'}\n  Deliverables: ${p.deliverables.join(', ') || 'N/A'}`;
    }).join('\n');
  }

  private async generateStrategy(reports: AgentMessage[]): Promise<any> {
    const db = getSqlite();

    // Gather company context
    const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
    const recentContent = db.prepare(
      "SELECT COUNT(*) as count, status FROM content GROUP BY status"
    ).all() as any[];
    const leadStats = db.prepare(
      "SELECT COUNT(*) as count, status FROM leads GROUP BY status"
    ).all() as any[];
    const revenue = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
    ).get() as any;
    const expenses = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
    ).get() as any;

    const reportSummary = reports.map(r =>
      `${r.fromAgent}: ${JSON.stringify(r.payload)}`
    ).join('\n');

    const productCatalog = this.getProductCatalogContext();

    const systemPrompt = `You are the CEO agent for ${company?.name || this.config.company.name}.
Company description: ${company?.description || this.config.company.description}
Services: ${this.config.company.services.join(', ')}
Target audience: ${this.config.company.targetAudience || 'general'}
Brand voice: ${this.config.brand.voiceTone}

PRODUCT CATALOG:
${productCatalog}

CORPORATE STRUCTURE:
You oversee the following departments:
- Content Department: Creates marketing content across platforms
- Sales Department: Identifies leads, generates outreach, manages pipeline
- Client Services: Manages proposals, invoicing, and client relationships
- Operations: Monitors budgets, agent health, and financial reporting
- Social Media: Publishes and schedules content across platforms

Think like a real corporate CEO. Your strategy should reference specific products by name,
direct content to highlight specific product features and pricing, and sales to target
prospects for specific product tiers. Every directive should tie back to selling real products.

Output valid JSON only.`;

    const userPrompt = `Generate a weekly strategy based on current state:

Content stats: ${JSON.stringify(recentContent)}
Lead stats: ${JSON.stringify(leadStats)}
Revenue: $${revenue?.total || 0}
Expenses: $${expenses?.total || 0}
Budget limit: $${this.config.budget.monthlyLimit}/month

Agent reports:
${reportSummary || 'No reports yet.'}

Enabled platforms: ${this.config.socialAccounts.filter(a => a.enabled).map(a => a.platform).join(', ') || 'none'}

Generate a JSON strategy with:
{
  "weeklyTheme": "string - content theme for the week tied to a specific product",
  "contentDirectives": [{"platform": "string", "type": "string", "topic": "string", "product": "string - product name to promote", "priority": "high|medium|low"}],
  "salesDirectives": [{"action": "string", "target": "string", "product": "string - product to pitch", "priority": "high|medium|low"}],
  "budgetGuidance": "string - spending guidance",
  "founderUpdate": "string - key highlights for the founder",
  "notes": "string - any other strategic notes"
}`;

    const response = await this.askLLM(systemPrompt, userPrompt, { json: true, temperature: 0.8 });

    let strategy: any;
    try {
      strategy = JSON.parse(response.content);
    } catch {
      strategy = {
        weeklyTheme: 'General business growth',
        contentDirectives: [
          { platform: 'linkedin', type: 'post', topic: this.config.company.services[0], priority: 'high' },
        ],
        salesDirectives: [
          { action: 'identify_leads', target: this.config.company.targetAudience || 'general', priority: 'high' },
        ],
        budgetGuidance: 'Conservative spending',
        founderUpdate: 'Strategy generated with default parameters.',
        notes: response.content,
      };
    }

    this.log.info({ strategy }, 'Weekly strategy generated');
    return strategy;
  }

  private async dispatchTasks(strategy: any): Promise<void> {
    // Send content directives to content agent
    if (strategy.contentDirectives?.length > 0) {
      this.sendMessage('content', 'task', {
        type: 'create_content',
        weeklyTheme: strategy.weeklyTheme,
        directives: strategy.contentDirectives,
      }, 1);
    }

    // Send sales directives
    if (strategy.salesDirectives?.length > 0) {
      this.sendMessage('sales', 'task', {
        type: 'execute_sales',
        directives: strategy.salesDirectives,
      }, 1);
    }

    // Send budget guidance to ops
    this.sendMessage('ops', 'task', {
      type: 'budget_update',
      guidance: strategy.budgetGuidance,
    });

    // Broadcast strategy summary
    this.sendMessage('broadcast', 'strategy', {
      weeklyTheme: strategy.weeklyTheme,
      notes: strategy.notes,
    });
  }

  private async sendFounderDigest(strategy: any, reports: AgentMessage[]): Promise<void> {
    try {
      const db = getSqlite();
      const revenue = (db.prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
      ).get() as any).total;
      const leadCount = (db.prepare('SELECT COUNT(*) as count FROM leads').get() as any).count;
      const productCount = (this.config.products || []).filter(p => p.active).length;

      const digest = [
        `Weekly Strategy: ${strategy.weeklyTheme}`,
        `Revenue: $${revenue}`,
        `Active Leads: ${leadCount}`,
        `Active Products: ${productCount}`,
        strategy.founderUpdate ? `Update: ${strategy.founderUpdate}` : '',
        strategy.notes ? `Notes: ${strategy.notes}` : '',
      ].filter(Boolean).join('\n');

      await notifyFounder(this.config, 'digest', digest, { subject: `Weekly Digest — ${this.config.company.name}` });
    } catch (err: any) {
      this.log.error({ err }, 'Failed to send founder digest');
    }
  }

  private async writeStrategyToNotion(strategy: any): Promise<void> {
    if (!this.config.notion?.apiKey) return;

    const dbId = this.config.notion.databases?.['strategy'];
    if (!dbId) return;

    try {
      const { NotionClient } = await import('../platforms/notion.js');
      const notion = new NotionClient(this.config);
      const body = [
        `# Weekly Strategy: ${strategy.weeklyTheme}`,
        '',
        '## Content Directives',
        ...(strategy.contentDirectives || []).map((d: any) =>
          `- [${d.priority}] ${d.platform}: ${d.topic}${d.product ? ` (Product: ${d.product})` : ''}`
        ),
        '',
        '## Sales Directives',
        ...(strategy.salesDirectives || []).map((d: any) =>
          `- [${d.priority}] ${d.action}: ${d.target}${d.product ? ` (Product: ${d.product})` : ''}`
        ),
        '',
        `## Budget Guidance`,
        strategy.budgetGuidance || 'N/A',
        '',
        `## Notes`,
        strategy.notes || 'N/A',
      ].join('\n');

      await notion.createPage(dbId, `Strategy — ${new Date().toISOString().split('T')[0]}`, body);
      this.log.info('Strategy written to Notion');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to write strategy to Notion');
    }
  }
}

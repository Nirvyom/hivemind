import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class ProcurementAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('procurement', 'Procurement', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'purchase_request':
            await this.processPurchaseRequest(msg.payload);
            break;
          case 'approve_po':
            await this.approvePO(msg.payload);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.trackToolSubscriptions();
    await this.checkRenewals();
    await this.analyzeCostOptimization();

    // Report to Finance and CEO
    const stats = this.getProcurementStats();
    this.sendMessage('finance', 'report', { agent: 'procurement', ...stats });
    this.sendMessage('ceo', 'report', { agent: 'procurement', ...stats });
  }

  private async trackToolSubscriptions(): Promise<void> {
    const db = getSqlite();
    const vendorCount = (db.prepare('SELECT COUNT(*) as count FROM vendors').get() as any).count;
    if (vendorCount > 0) return; // Already seeded

    // Seed vendors from config
    const vendorsToSeed: { name: string; category: string; service: string; billingCycle: string }[] = [];

    // LLM Provider
    const llmNames: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama (Local)' };
    vendorsToSeed.push({
      name: llmNames[this.config.llm.provider] || this.config.llm.provider,
      category: 'llm_provider',
      service: `${this.config.llm.model} API`,
      billingCycle: 'usage_based',
    });

    // Stripe
    if (this.config.stripe?.secretKey) {
      vendorsToSeed.push({ name: 'Stripe', category: 'saas', service: 'Payment Processing', billingCycle: 'usage_based' });
    }

    // Email provider
    if (this.config.email?.provider) {
      const emailName = this.config.email.provider === 'resend' ? 'Resend' : 'Gmail';
      vendorsToSeed.push({ name: emailName, category: 'saas', service: 'Email Service', billingCycle: 'monthly' });
    }

    // Notion
    if (this.config.notion?.apiKey) {
      vendorsToSeed.push({ name: 'Notion', category: 'saas', service: 'Knowledge Base', billingCycle: 'monthly' });
    }

    for (const v of vendorsToSeed) {
      const result = db.prepare(`
        INSERT INTO vendors (name, category, status, created_at, updated_at)
        VALUES (?, ?, 'active', datetime('now'), datetime('now'))
      `).run(v.name, v.category);

      const vendorId = result.lastInsertRowid;

      db.prepare(`
        INSERT INTO subscriptions_outgoing (vendor_id, service_name, amount, currency, billing_cycle, status, category, created_at, updated_at)
        VALUES (?, ?, 0, 'USD', ?, 'active', ?, datetime('now'), datetime('now'))
      `).run(vendorId, v.service, v.billingCycle, v.category);
    }

    this.log.info({ count: vendorsToSeed.length }, 'Vendor subscriptions seeded');
  }

  private async checkRenewals(): Promise<void> {
    const db = getSqlite();
    const fourteenDaysFromNow = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

    const upcoming = db.prepare(`
      SELECT so.*, v.name as vendor_name
      FROM subscriptions_outgoing so
      JOIN vendors v ON so.vendor_id = v.id
      WHERE so.status = 'active' AND so.renewal_date IS NOT NULL AND so.renewal_date <= ?
    `).all(fourteenDaysFromNow) as any[];

    for (const sub of upcoming) {
      this.sendMessage('ceo', 'alert', {
        type: 'subscription_renewal',
        vendor: sub.vendor_name,
        service: sub.service_name,
        amount: sub.amount,
        renewalDate: sub.renewal_date,
        autoRenew: sub.auto_renew,
        message: `Subscription "${sub.service_name}" from ${sub.vendor_name} ($${sub.amount}/${sub.billing_cycle}) renews on ${sub.renewal_date}.`,
      }, 1);
    }

    if (upcoming.length > 0) {
      this.log.info({ count: upcoming.length }, 'Upcoming renewals flagged');
    }
  }

  private async analyzeCostOptimization(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7);

    // Only run monthly
    const lastAnalysis = db.prepare(`
      SELECT id FROM purchase_orders
      WHERE category = 'cost_analysis' AND created_at >= ?
    `).get(`${currentPeriod}-01`);
    if (lastAnalysis) return;

    // Gather spending data
    const monthStart = `${currentPeriod}-01`;
    const costByCategory = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM transactions WHERE type = 'expense' AND created_at >= ?
      GROUP BY category
    `).all(monthStart) as any[];

    const tokensByAgent = db.prepare(`
      SELECT agent, COALESCE(SUM(tokens_used), 0) as tokens, COALESCE(SUM(cost), 0) as cost
      FROM agent_runs WHERE started_at >= ?
      GROUP BY agent
    `).all(monthStart) as any[];

    if (costByCategory.length === 0 && tokensByAgent.length === 0) return;

    try {
      const response = await this.askLLM(
        `You are the Procurement Manager for ${this.config.company.name}. Analyze spending and recommend cost optimizations. Output valid JSON only.`,
        `Analyze monthly spending:
Cost by category: ${JSON.stringify(costByCategory)}
LLM usage by agent: ${JSON.stringify(tokensByAgent)}
Monthly budget: $${this.config.budget.monthlyLimit}
LLM provider: ${this.config.llm.provider} / ${this.config.llm.model}

Return JSON:
{
  "total_monthly_cost": 0,
  "recommendations": [{"action": "description", "estimated_savings": 0, "risk": "low|medium|high"}],
  "top_cost_driver": "category name",
  "narrative": "brief analysis"
}`,
        { json: true }
      );

      let analysis: any;
      try {
        analysis = JSON.parse(response.content);
      } catch { return; }

      // Store as a special PO record for tracking
      db.prepare(`
        INSERT INTO purchase_orders (po_number, vendor_id, description, amount, currency, status, category, requested_by, notes, created_at, updated_at)
        VALUES (?, (SELECT id FROM vendors LIMIT 1), ?, 0, 'USD', 'received', 'cost_analysis', 'procurement', ?, datetime('now'), datetime('now'))
      `).run(
        `ANALYSIS-${currentPeriod}`,
        `Cost Optimization Analysis — ${currentPeriod}`,
        JSON.stringify(analysis)
      );

      // Send to CEO if significant savings found
      const totalSavings = (analysis.recommendations || []).reduce((sum: number, r: any) => sum + (r.estimated_savings || 0), 0);
      if (totalSavings > 0) {
        this.sendMessage('ceo', 'report', {
          type: 'cost_optimization',
          period: currentPeriod,
          potentialSavings: totalSavings,
          recommendations: analysis.recommendations,
          narrative: analysis.narrative,
        }, 1);
      }

      this.log.info({ period: currentPeriod, savings: totalSavings }, 'Cost analysis completed');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to analyze costs');
    }
  }

  private async processPurchaseRequest(payload: any): Promise<void> {
    const { vendorName, description, amount, category, requestedBy } = payload;
    const db = getSqlite();

    // Find or create vendor
    let vendor = db.prepare('SELECT id FROM vendors WHERE name = ?').get(vendorName) as any;
    if (!vendor) {
      const result = db.prepare(`
        INSERT INTO vendors (name, category, status, created_at, updated_at)
        VALUES (?, ?, 'active', datetime('now'), datetime('now'))
      `).run(vendorName, category || 'general');
      vendor = { id: result.lastInsertRowid };
    }

    const poNumber = `PO-${Date.now()}`;
    const autoApproveThreshold = this.config.budget.monthlyLimit * 0.05; // 5% of monthly budget

    const status = amount <= autoApproveThreshold ? 'approved' : 'pending_approval';

    db.prepare(`
      INSERT INTO purchase_orders (po_number, vendor_id, description, amount, currency, status, category, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(poNumber, vendor.id, description, amount, status, category, requestedBy);

    if (status === 'pending_approval') {
      this.sendMessage('ceo', 'task', {
        type: 'approval_request',
        entity: 'purchase_order',
        poNumber,
        vendorName,
        description,
        amount,
        message: `Purchase order ${poNumber} for $${amount} from ${vendorName} requires approval.`,
      }, 1);
    }

    this.log.info({ poNumber, vendor: vendorName, amount, status }, 'Purchase request processed');
  }

  private async approvePO(payload: any): Promise<void> {
    const { poNumber, approvedBy } = payload;
    const db = getSqlite();

    db.prepare(`
      UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
      WHERE po_number = ?
    `).run(approvedBy || 'ceo', poNumber);

    this.log.info({ poNumber }, 'Purchase order approved');
  }

  private getProcurementStats() {
    const db = getSqlite();
    const vendorCount = (db.prepare("SELECT COUNT(*) as count FROM vendors WHERE status = 'active'").get() as any).count;
    const activeSubscriptions = (db.prepare("SELECT COUNT(*) as count FROM subscriptions_outgoing WHERE status = 'active'").get() as any).count;
    const monthlyVendorSpend = (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions_outgoing WHERE status = 'active'").get() as any).total;
    const pendingPOs = (db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE status = 'pending_approval'").get() as any).count;

    return { activeVendors: vendorCount, activeSubscriptions, monthlyVendorSpend, pendingPOs };
  }
}

import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

const ALL_AGENTS = [
  { name: 'ceo', display: 'Chief Executive Officer', department: 'executive', role: 'CEO', reportsTo: null },
  { name: 'content', display: 'Content Creator', department: 'marketing', role: 'Content Manager', reportsTo: 'ceo' },
  { name: 'social', display: 'Social Media Manager', department: 'marketing', role: 'Social Media Manager', reportsTo: 'ceo' },
  { name: 'sales', display: 'Sales Representative', department: 'sales', role: 'Sales Manager', reportsTo: 'ceo' },
  { name: 'client', display: 'Client Services Manager', department: 'client_services', role: 'Client Manager', reportsTo: 'ceo' },
  { name: 'ops', display: 'Operations Manager', department: 'operations', role: 'Operations Manager', reportsTo: 'ceo' },
  { name: 'hr', display: 'HR Director', department: 'human_resources', role: 'HR Director', reportsTo: 'ceo' },
  { name: 'finance', display: 'Chief Financial Officer', department: 'finance', role: 'CFO', reportsTo: 'ceo' },
  { name: 'legal', display: 'General Counsel', department: 'legal', role: 'General Counsel', reportsTo: 'ceo' },
  { name: 'billing', display: 'Billing Manager', department: 'billing', role: 'Billing Manager', reportsTo: 'finance' },
  { name: 'procurement', display: 'Procurement Manager', department: 'procurement', role: 'Procurement Manager', reportsTo: 'finance' },
];

export class HRAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('hr', 'HR', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'generate_policy':
            await this.generatePolicy(msg.payload.category, msg.payload.title);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.ensureOrgChartPopulated();
    await this.generatePerformanceReviews();
    await this.auditPolicies();

    // Report to CEO
    const orgHealth = this.getOrgHealth();
    this.sendMessage('ceo', 'report', { agent: 'hr', orgHealth });
  }

  private async ensureOrgChartPopulated(): Promise<void> {
    const db = getSqlite();

    for (const agent of ALL_AGENTS) {
      const existing = db.prepare('SELECT id FROM employees WHERE agent_name = ?').get(agent.name);
      if (!existing) {
        db.prepare(`
          INSERT INTO employees (agent_name, display_name, department, role, reports_to, status, hired_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'), datetime('now'))
        `).run(agent.name, agent.display, agent.department, agent.role, agent.reportsTo);
        this.log.info({ agent: agent.name }, 'Employee added to org chart');
      }
    }
  }

  private async generatePerformanceReviews(): Promise<void> {
    const db = getSqlite();
    const currentPeriod = new Date().toISOString().slice(0, 7); // '2026-10'

    for (const agent of ALL_AGENTS) {
      // Check if review already exists for this period
      const existing = db.prepare(
        'SELECT id FROM performance_reviews WHERE agent_name = ? AND review_period = ?'
      ).get(agent.name, currentPeriod);
      if (existing) continue;

      // Gather metrics from agent_runs for current month
      const monthStart = `${currentPeriod}-01`;
      const metrics = db.prepare(`
        SELECT
          COUNT(*) as total_runs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_runs,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
          COALESCE(SUM(tokens_used), 0) as total_tokens,
          COALESCE(SUM(cost), 0) as total_cost,
          AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
            THEN (julianday(completed_at) - julianday(started_at)) * 86400
            ELSE NULL END) as avg_duration
        FROM agent_runs
        WHERE agent = ? AND started_at >= ?
      `).get(agent.name, monthStart) as any;

      if (metrics.total_runs === 0) continue;

      const successRate = metrics.total_runs > 0
        ? ((metrics.successful_runs / metrics.total_runs) * 100).toFixed(1)
        : '0';

      try {
        const response = await this.askLLM(
          `You are the HR Director for ${this.config.company.name}. Generate a performance review for an AI agent employee. Output valid JSON only.`,
          `Generate a performance review for:
Agent: ${agent.display} (${agent.role})
Department: ${agent.department}
Period: ${currentPeriod}

Metrics:
- Total runs: ${metrics.total_runs}
- Success rate: ${successRate}%
- Failed runs: ${metrics.failed_runs}
- Total tokens used: ${metrics.total_tokens}
- Total cost: $${metrics.total_cost.toFixed(2)}
- Avg run duration: ${metrics.avg_duration ? metrics.avg_duration.toFixed(1) + 's' : 'N/A'}

Return JSON:
{
  "score": 1-100,
  "summary": "brief narrative review",
  "strengths": ["strength 1"],
  "improvements": ["area for improvement"],
  "recommendations": ["recommendation"]
}`,
          { json: true }
        );

        let review: any;
        try {
          review = JSON.parse(response.content);
        } catch {
          review = { score: 50, summary: 'Review pending manual assessment.', strengths: [], improvements: [], recommendations: [] };
        }

        db.prepare(`
          INSERT INTO performance_reviews (agent_name, review_period, total_runs, successful_runs, failed_runs, total_tokens, total_cost, avg_run_duration_seconds, performance_score, llm_summary, recommendations, reviewed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          agent.name, currentPeriod, metrics.total_runs, metrics.successful_runs,
          metrics.failed_runs, metrics.total_tokens, metrics.total_cost,
          metrics.avg_duration, review.score, review.summary, JSON.stringify(review.recommendations)
        );

        this.log.info({ agent: agent.name, score: review.score }, 'Performance review generated');
      } catch (err: any) {
        this.log.error({ err, agent: agent.name }, 'Failed to generate performance review');
      }
    }
  }

  private async auditPolicies(): Promise<void> {
    const db = getSqlite();
    const requiredCategories = ['operations', 'security', 'communication', 'budget', 'content'];

    for (const category of requiredCategories) {
      const existing = db.prepare(
        "SELECT id FROM policies WHERE category = ? AND status = 'active'"
      ).get(category);

      if (existing) continue;

      try {
        const response = await this.askLLM(
          `You are the HR Director for ${this.config.company.name}. Generate a company policy. Output valid JSON only.`,
          `Generate a ${category} policy for ${this.config.company.name}.
Company: ${this.config.company.description}
Industry: ${this.config.company.industry || 'general'}

Return JSON:
{
  "title": "Policy title",
  "body": "Full policy text with sections"
}`,
          { json: true }
        );

        let policy: any;
        try {
          policy = JSON.parse(response.content);
        } catch {
          continue;
        }

        db.prepare(`
          INSERT INTO policies (title, category, body, version, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'draft', datetime('now'), datetime('now'))
        `).run(policy.title, category, policy.body);

        // Request CEO approval
        this.sendMessage('ceo', 'task', {
          type: 'approval_request',
          entity: 'policy',
          category,
          title: policy.title,
          message: `New ${category} policy drafted: "${policy.title}". Please review and approve.`,
        }, 1);

        this.log.info({ category, title: policy.title }, 'Policy drafted');
      } catch (err: any) {
        this.log.error({ err, category }, 'Failed to generate policy');
      }
    }
  }

  private async generatePolicy(category: string, title?: string): Promise<void> {
    // Explicit policy generation via task message
    await this.auditPolicies();
  }

  private getOrgHealth() {
    const db = getSqlite();
    const totalEmployees = (db.prepare('SELECT COUNT(*) as count FROM employees').get() as any).count;
    const activeEmployees = (db.prepare("SELECT COUNT(*) as count FROM employees WHERE status = 'active'").get() as any).count;
    const policyCount = (db.prepare("SELECT COUNT(*) as count FROM policies WHERE status = 'active'").get() as any).count;
    const reviewCount = (db.prepare('SELECT COUNT(*) as count FROM performance_reviews').get() as any).count;

    return { totalEmployees, activeEmployees, activePolicies: policyCount, totalReviews: reviewCount };
  }
}

import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { createApproval, getApprovedActions, markApprovalExecuted } from '../services/approval.js';
import type { HivemindConfig } from '../config/schema.js';

export class PipelineAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('pipeline' as any, 'Pipeline', config);
  }

  protected async execute(_messages: AgentMessage[]): Promise<void> {
    await this.qualifyNewLeads();
    await this.draftResponses();
    await this.processApprovedActions();
    await this.detectStaleLeads();
    await this.updatePipelineStages();
  }

  private async qualifyNewLeads(): Promise<void> {
    const db = getSqlite();
    const newLeads = db.prepare(
      "SELECT * FROM leads WHERE stage = 'enquiry' AND service_fit_score IS NULL ORDER BY created_at DESC LIMIT 10"
    ).all() as any[];

    if (newLeads.length === 0) return;

    const companyContext = `Company: ${this.config.company.name}\nServices: ${this.config.company.services.join(', ')}\nTarget: ${this.config.company.targetAudience || 'service businesses'}`;

    for (const lead of newLeads) {
      try {
        const response = await this.askLLM(
          `You are a lead qualification specialist for a service business.\n${companyContext}\n\nScore leads 1-100 on service fit. Extract requirements, budget signals, and urgency. Respond in JSON.`,
          `Qualify this lead:\nName: ${lead.name}\nEmail: ${lead.email || 'N/A'}\nCompany: ${lead.company || 'N/A'}\nSource: ${lead.source}\nNotes: ${lead.notes || 'None'}\nRequirements: ${lead.requirements || 'None'}`,
          { json: true, maxTokens: 512 }
        );

        const result = JSON.parse(response.content);

        db.prepare(`
          UPDATE leads SET
            service_fit_score = ?,
            requirements = COALESCE(?, requirements),
            budget_range = COALESCE(?, budget_range),
            urgency = COALESCE(?, urgency),
            stage = CASE WHEN ? >= 50 THEN 'qualified' ELSE stage END,
            qualified_at = CASE WHEN ? >= 50 THEN datetime('now') ELSE qualified_at END,
            next_action = ?,
            next_action_due = datetime('now', '+1 day'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          result.score || 50,
          result.requirements || null,
          result.budget_range || result.budget || null,
          result.urgency || null,
          result.score || 50,
          result.score || 50,
          result.next_action || 'Send initial response',
          lead.id
        );

        // Log activity
        db.prepare(`
          INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, metadata, created_by)
          VALUES (?, 'note', null, 'manual', 'Lead qualified', ?, 'pipeline')
        `).run(lead.id, JSON.stringify({ score: result.score, summary: result.summary || '' }));

        this.log.info({ leadId: lead.id, score: result.score }, 'Lead qualified');
      } catch (err) {
        this.log.error({ err, leadId: lead.id }, 'Failed to qualify lead');
      }
    }
  }

  private async draftResponses(): Promise<void> {
    const db = getSqlite();
    const qualifiedLeads = db.prepare(
      "SELECT * FROM leads WHERE stage = 'qualified' AND next_action LIKE '%response%' ORDER BY urgency DESC, created_at ASC LIMIT 5"
    ).all() as any[];

    for (const lead of qualifiedLeads) {
      try {
        const response = await this.askLLM(
          `You are a business development specialist for ${this.config.company.name}.\nServices: ${this.config.company.services.join(', ')}\n\nDraft a professional, warm initial response email. Be concise and include a clear next step (call/meeting). Do NOT include subject line separately.`,
          `Draft response for:\nName: ${lead.name}\nCompany: ${lead.company || 'N/A'}\nRequirements: ${lead.requirements || 'General inquiry'}\nBudget: ${lead.budget_range || 'Unknown'}\nUrgency: ${lead.urgency || 'normal'}`,
          { maxTokens: 1024 }
        );

        await createApproval({
          type: 'reply',
          entityType: 'lead',
          entityId: String(lead.id),
          agent: 'pipeline',
          title: `Reply to ${lead.name}`,
          summary: `Initial response to ${lead.name}${lead.company ? ` from ${lead.company}` : ''}. Requirements: ${(lead.requirements || 'General inquiry').substring(0, 100)}`,
          draftContent: response.content,
          actionData: { leadId: lead.id, action: 'send_reply' },
          priority: lead.urgency === 'high' ? 2 : 3,
        }, this.config);
      } catch (err) {
        this.log.error({ err, leadId: lead.id }, 'Failed to draft response');
      }
    }
  }

  private async processApprovedActions(): Promise<void> {
    const db = getSqlite();
    const approved = getApprovedActions('pipeline');

    for (const approval of approved) {
      try {
        const actionData = approval.actionData ? JSON.parse(approval.actionData) : {};

        if (actionData.action === 'send_reply') {
          // Update lead stage
          db.prepare(`
            UPDATE leads SET
              stage = 'responded',
              last_contacted_at = datetime('now'),
              next_action = 'Follow up in 2 days',
              next_action_due = datetime('now', '+2 days'),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(actionData.leadId);

          // Log activity
          db.prepare(`
            INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, body, created_by)
            VALUES (?, 'email_sent', 'outbound', 'email', 'Initial response', ?, 'pipeline')
          `).run(actionData.leadId, approval.draftContent);
        }

        markApprovalExecuted(approval.id);
        this.log.info({ approvalId: approval.id }, 'Approved action executed');
      } catch (err) {
        this.log.error({ err, approvalId: approval.id }, 'Failed to execute approved action');
      }
    }
  }

  private async detectStaleLeads(): Promise<void> {
    const db = getSqlite();
    const staleLeads = db.prepare(`
      SELECT id, name, company, stage, next_action, next_action_due
      FROM leads
      WHERE next_action_due IS NOT NULL
        AND next_action_due < datetime('now')
        AND stage NOT IN ('won', 'lost', 'dormant')
      ORDER BY next_action_due ASC
      LIMIT 20
    `).all() as any[];

    if (staleLeads.length > 0) {
      this.log.warn({ count: staleLeads.length }, 'Stale leads detected');
    }
  }

  private async updatePipelineStages(): Promise<void> {
    const db = getSqlite();

    // Move leads with proposals to proposal_sent stage
    db.prepare(`
      UPDATE leads SET stage = 'proposal_sent', proposal_sent_at = datetime('now'), updated_at = datetime('now')
      WHERE stage = 'responded'
        AND id IN (
          SELECT lead_id FROM opportunity_activities WHERE activity_type = 'proposal_sent'
          EXCEPT SELECT id FROM leads WHERE stage IN ('proposal_sent', 'negotiating', 'won', 'lost')
        )
    `).run();

    // Mark very old leads as dormant
    db.prepare(`
      UPDATE leads SET stage = 'dormant', updated_at = datetime('now')
      WHERE stage NOT IN ('won', 'lost', 'dormant')
        AND next_action_due IS NOT NULL
        AND next_action_due < datetime('now', '-30 days')
    `).run();
  }
}

import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import { createApproval, getApprovedActions, markApprovalExecuted } from '../services/approval.js';
import type { HivemindConfig } from '../config/schema.js';

export class EngagementAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('engagement' as any, 'Engagement', config);
  }

  protected async execute(_messages: AgentMessage[]): Promise<void> {
    await this.runFollowUpSequences();
    await this.generateProposals();
    await this.processApprovedProposals();
    await this.detectEngagementDrops();
  }

  private async runFollowUpSequences(): Promise<void> {
    const db = getSqlite();

    // Find leads that need follow-up
    const leadsNeedingFollowUp = db.prepare(`
      SELECT l.*, MAX(oa.created_at) as last_activity_at
      FROM leads l
      LEFT JOIN opportunity_activities oa ON oa.lead_id = l.id
      WHERE l.stage IN ('responded', 'proposal_sent', 'negotiating')
        AND l.next_action_due IS NOT NULL
        AND l.next_action_due <= datetime('now')
      GROUP BY l.id
      ORDER BY l.urgency DESC, l.next_action_due ASC
      LIMIT 10
    `).all() as any[];

    for (const lead of leadsNeedingFollowUp) {
      try {
        const activities = db.prepare(
          'SELECT activity_type, subject, created_at FROM opportunity_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 5'
        ).all(lead.id) as any[];

        const activitySummary = activities.map(a => `${a.activity_type}: ${a.subject || 'N/A'} (${a.created_at})`).join('\n');

        const response = await this.askLLM(
          `You are a follow-up specialist for ${this.config.company.name}.\nServices: ${this.config.company.services.join(', ')}\n\nDraft a follow-up message. Be brief, professional, and include a clear CTA. Consider the conversation history.`,
          `Follow up with:\nName: ${lead.name}\nCompany: ${lead.company || 'N/A'}\nStage: ${lead.stage}\nRequirements: ${lead.requirements || 'N/A'}\nLast action: ${lead.next_action || 'N/A'}\n\nRecent activity:\n${activitySummary || 'None'}`,
          { maxTokens: 512 }
        );

        await createApproval({
          type: 'follow_up',
          entityType: 'lead',
          entityId: String(lead.id),
          agent: 'engagement',
          title: `Follow up: ${lead.name}`,
          summary: `Follow-up for ${lead.name} (${lead.stage}). Last activity: ${activities[0]?.created_at || 'unknown'}`,
          draftContent: response.content,
          actionData: { leadId: lead.id, action: 'send_follow_up' },
          priority: lead.urgency === 'high' ? 2 : 3,
        }, this.config);
      } catch (err) {
        this.log.error({ err, leadId: lead.id }, 'Failed to draft follow-up');
      }
    }
  }

  private async generateProposals(): Promise<void> {
    const db = getSqlite();

    // Find qualified leads ready for proposals
    const leadsForProposal = db.prepare(`
      SELECT * FROM leads
      WHERE stage IN ('qualified', 'responded')
        AND requirements IS NOT NULL
        AND budget_range IS NOT NULL
        AND service_fit_score >= 60
      ORDER BY service_fit_score DESC
      LIMIT 3
    `).all() as any[];

    const templates = db.prepare(
      "SELECT * FROM proposal_templates WHERE status = 'active'"
    ).all() as any[];

    const rateCards = db.prepare(
      "SELECT * FROM rate_cards WHERE status = 'active'"
    ).all() as any[];

    const rateContext = rateCards.length > 0
      ? rateCards.map(r => `${r.service_category}/${r.item}: ${r.currency} ${r.rate_amount}/${r.unit}`).join('\n')
      : 'No rate cards configured';

    for (const lead of leadsForProposal) {
      try {
        const matchingTemplate = templates.find(t => {
          if (!t.category) return true;
          return (lead.requirements || '').toLowerCase().includes(t.category.toLowerCase());
        });

        const templateContext = matchingTemplate
          ? `Use this template as a base:\n${matchingTemplate.template_body}`
          : '';

        const response = await this.askLLM(
          `You are a proposal writer for ${this.config.company.name}.\nServices: ${this.config.company.services.join(', ')}\n\nCreate a concise, professional proposal. Include: scope of work, deliverables, timeline, and pricing. Use the rate cards for pricing.\n\nRate Cards:\n${rateContext}\n\n${templateContext}`,
          `Create proposal for:\nName: ${lead.name}\nCompany: ${lead.company || 'N/A'}\nRequirements: ${lead.requirements}\nBudget: ${lead.budget_range || 'Flexible'}\nUrgency: ${lead.urgency || 'normal'}`,
          { maxTokens: 2048 }
        );

        await createApproval({
          type: 'proposal',
          entityType: 'lead',
          entityId: String(lead.id),
          agent: 'engagement',
          title: `Proposal for ${lead.name}`,
          summary: `Service proposal for ${lead.name}${lead.company ? ` (${lead.company})` : ''}. Budget: ${lead.budget_range || 'TBD'}`,
          draftContent: response.content,
          actionData: { leadId: lead.id, action: 'send_proposal' },
          priority: 2,
        }, this.config);
      } catch (err) {
        this.log.error({ err, leadId: lead.id }, 'Failed to generate proposal');
      }
    }
  }

  private async processApprovedProposals(): Promise<void> {
    const db = getSqlite();
    const approved = getApprovedActions('engagement');

    for (const approval of approved) {
      try {
        const actionData = approval.actionData ? JSON.parse(approval.actionData) : {};

        if (actionData.action === 'send_proposal') {
          db.prepare(`
            UPDATE leads SET
              stage = 'proposal_sent',
              proposal_sent_at = datetime('now'),
              next_action = 'Follow up on proposal',
              next_action_due = datetime('now', '+3 days'),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(actionData.leadId);

          db.prepare(`
            INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, body, created_by)
            VALUES (?, 'proposal_sent', 'outbound', 'email', 'Proposal sent', ?, 'engagement')
          `).run(actionData.leadId, approval.draftContent);
        } else if (actionData.action === 'send_follow_up') {
          db.prepare(`
            UPDATE leads SET
              last_contacted_at = datetime('now'),
              next_action = 'Await response',
              next_action_due = datetime('now', '+3 days'),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(actionData.leadId);

          db.prepare(`
            INSERT INTO opportunity_activities (lead_id, activity_type, direction, channel, subject, body, created_by)
            VALUES (?, 'follow_up', 'outbound', 'email', 'Follow-up sent', ?, 'engagement')
          `).run(actionData.leadId, approval.draftContent);
        }

        markApprovalExecuted(approval.id);
      } catch (err) {
        this.log.error({ err, approvalId: approval.id }, 'Failed to process approved proposal');
      }
    }
  }

  private async detectEngagementDrops(): Promise<void> {
    const db = getSqlite();

    // Flag leads that haven't responded after proposal
    const silentLeads = db.prepare(`
      SELECT l.id, l.name, l.company, l.proposal_sent_at
      FROM leads l
      WHERE l.stage = 'proposal_sent'
        AND l.proposal_sent_at IS NOT NULL
        AND l.proposal_sent_at < datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1 FROM opportunity_activities oa
          WHERE oa.lead_id = l.id
            AND oa.direction = 'inbound'
            AND oa.created_at > l.proposal_sent_at
        )
    `).all() as any[];

    if (silentLeads.length > 0) {
      this.log.warn({ count: silentLeads.length }, 'Silent leads post-proposal detected');
    }
  }
}

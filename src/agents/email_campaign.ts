import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class EmailCampaignAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('email_campaign', 'Email Campaign', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'create_drip':
            await this.createDripCampaign(msg.payload);
            break;
          case 'send_welcome':
            await this.sendWelcomeSequence(msg.payload);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.manageDripSequences();
    await this.trackEmailMetrics();

    // Monthly newsletter (1st of month)
    if (new Date().getDate() === 1) {
      await this.generateNewsletter();
    }

    const stats = this.getCampaignStats();
    this.sendMessage('ceo', 'report', { agent: 'email_campaign', stats });
  }

  private async manageDripSequences(): Promise<void> {
    const db = getSqlite();

    // Find active drip campaigns with pending sends
    const activeCampaigns = db.prepare(`
      SELECT ec.*, es.id as seq_id, es.step_number, es.delay_days, es.subject as seq_subject, es.body as seq_body
      FROM email_campaigns ec
      JOIN email_sequences es ON es.campaign_id = ec.id AND es.status = 'active'
      WHERE ec.type = 'drip' AND ec.status = 'active'
      ORDER BY ec.id, es.step_number
    `).all() as any[];

    for (const campaign of activeCampaigns) {
      // Find recipients who need the next step
      const pendingSends = db.prepare(`
        SELECT DISTINCT es2.recipient_email, es2.lead_id, es2.client_id
        FROM email_sends es2
        WHERE es2.campaign_id = ? AND es2.sequence_step = ?
        AND es2.status = 'sent'
        AND es2.sent_at <= datetime('now', ? || ' days')
        AND NOT EXISTS (
          SELECT 1 FROM email_sends es3
          WHERE es3.campaign_id = ? AND es3.recipient_email = es2.recipient_email
          AND es3.sequence_step = ?
        )
      `).all(
        campaign.id,
        campaign.step_number - 1,
        `-${campaign.delay_days}`,
        campaign.id,
        campaign.step_number
      ) as any[];

      for (const recipient of pendingSends) {
        db.prepare(`
          INSERT INTO email_sends (campaign_id, sequence_step, recipient_email, lead_id, client_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'))
        `).run(campaign.id, campaign.step_number, recipient.recipient_email, recipient.lead_id, recipient.client_id);

        // Queue email via client agent
        this.sendMessage('client', 'task', {
          type: 'send_email',
          to: recipient.recipient_email,
          subject: campaign.seq_subject,
          body: campaign.seq_body,
        });
      }

      if (pendingSends.length > 0) {
        this.log.info({ campaign: campaign.name, step: campaign.step_number, count: pendingSends.length }, 'Drip sequence advanced');
      }
    }
  }

  private async generateNewsletter(): Promise<void> {
    const db = getSqlite();

    const recentContent = db.prepare(`
      SELECT title, platform, type FROM content
      WHERE status = 'published' AND created_at >= datetime('now', '-30 days')
      ORDER BY created_at DESC LIMIT 10
    `).all() as any[];

    const activeProducts = (this.config.products || []).filter(p => p.active);

    try {
      const response = await this.askLLM(
        `You are the email marketing manager for ${this.config.company.name}. Generate a monthly newsletter. Output valid JSON.`,
        `Create a monthly newsletter based on:
Recent content: ${JSON.stringify(recentContent)}
Products: ${activeProducts.map(p => p.name).join(', ')}
Company: ${this.config.company.description}

Return JSON:
{
  "subject": "newsletter subject line",
  "body": "newsletter body in plain text (professional, informative)",
  "highlights": ["key highlight 1", "key highlight 2"]
}`,
        { json: true }
      );

      let newsletter: any;
      try {
        newsletter = JSON.parse(response.content);
      } catch {
        this.log.warn('Failed to parse newsletter JSON');
        return;
      }

      const result = db.prepare(`
        INSERT INTO email_campaigns (name, type, status, subject, body, created_at, updated_at)
        VALUES (?, 'newsletter', 'draft', ?, ?, datetime('now'), datetime('now'))
      `).run(
        `Monthly Newsletter — ${new Date().toISOString().slice(0, 7)}`,
        newsletter.subject,
        newsletter.body
      );

      this.log.info({ campaignId: Number(result.lastInsertRowid) }, 'Monthly newsletter generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate newsletter');
    }
  }

  private async trackEmailMetrics(): Promise<void> {
    const db = getSqlite();

    // Update campaign aggregate metrics from individual sends
    const campaigns = db.prepare(`
      SELECT id FROM email_campaigns WHERE status IN ('active', 'completed')
    `).all() as any[];

    for (const campaign of campaigns) {
      const metrics = db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('sent', 'opened', 'clicked') THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN status IN ('opened', 'clicked') THEN 1 ELSE 0 END) as opened,
          SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as clicked
        FROM email_sends WHERE campaign_id = ?
      `).get(campaign.id) as any;

      db.prepare(`
        UPDATE email_campaigns SET sent_count = ?, open_count = ?, click_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(metrics.sent || 0, metrics.opened || 0, metrics.clicked || 0, campaign.id);
    }
  }

  private async sendWelcomeSequence(payload: any): Promise<void> {
    const { clientId, clientName, clientEmail } = payload;
    const db = getSqlite();

    // Create welcome drip campaign for this client
    const result = db.prepare(`
      INSERT INTO email_campaigns (name, type, status, audience_segment, created_at, updated_at)
      VALUES (?, 'drip', 'active', 'new_client', datetime('now'), datetime('now'))
    `).run(`Welcome — ${clientName}`);

    const campaignId = Number(result.lastInsertRowid);

    // Create welcome sequence steps
    const steps = [
      { step: 1, delay: 0, subject: `Welcome to ${this.config.company.name}!`, body: `Hi ${clientName},\n\nWelcome aboard! We're excited to work with you.\n\nBest,\n${this.config.company.name}` },
      { step: 2, delay: 3, subject: `Getting Started — ${this.config.company.name}`, body: `Hi ${clientName},\n\nHere are some resources to help you get started...\n\nBest,\n${this.config.company.name}` },
      { step: 3, delay: 7, subject: `How's everything going?`, body: `Hi ${clientName},\n\nJust checking in to make sure everything is going well. Feel free to reach out if you need anything.\n\nBest,\n${this.config.company.name}` },
    ];

    for (const step of steps) {
      db.prepare(`
        INSERT INTO email_sequences (campaign_id, step_number, delay_days, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(campaignId, step.step, step.delay, step.subject, step.body);
    }

    // Queue first email immediately
    db.prepare(`
      INSERT INTO email_sends (campaign_id, sequence_step, recipient_email, client_id, status, created_at)
      VALUES (?, 1, ?, ?, 'queued', datetime('now'))
    `).run(campaignId, clientEmail, clientId);

    this.sendMessage('client', 'task', {
      type: 'send_email',
      to: clientEmail,
      subject: steps[0].subject,
      body: steps[0].body,
    });

    this.log.info({ clientName, campaignId }, 'Welcome sequence created');
  }

  private async createDripCampaign(payload: any): Promise<void> {
    const { name, subject, body, audienceSegment } = payload;
    const db = getSqlite();

    db.prepare(`
      INSERT INTO email_campaigns (name, type, status, subject, body, audience_segment, created_at, updated_at)
      VALUES (?, 'drip', 'draft', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(name, subject, body, audienceSegment);

    this.log.info({ name }, 'Drip campaign created');
  }

  private getCampaignStats() {
    const db = getSqlite();
    const totalCampaigns = (db.prepare('SELECT COUNT(*) as c FROM email_campaigns').get() as any).c;
    const activeCampaigns = (db.prepare("SELECT COUNT(*) as c FROM email_campaigns WHERE status = 'active'").get() as any).c;
    const totalSent = (db.prepare("SELECT COUNT(*) as c FROM email_sends WHERE status IN ('sent', 'opened', 'clicked')").get() as any).c;
    return { totalCampaigns, activeCampaigns, totalSent };
  }
}

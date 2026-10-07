import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';
import { getPlatformClient } from '../platforms/index.js';

export class SocialAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('social', 'Social', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    // Process scheduling tasks
    const tasks = messages.filter(m => m.type === 'task');
    for (const task of tasks) {
      this.markMessageProcessed(task.id);
    }

    // Post approved content
    await this.postApprovedContent();

    // Fetch engagement metrics
    await this.fetchEngagement();

    // Report to CEO
    this.sendMessage('ceo', 'report', {
      agent: 'social',
      postsToday: this.getPostCount('today'),
      pendingPosts: this.getPendingCount(),
    });
  }

  private async postApprovedContent(): Promise<void> {
    const db = getSqlite();
    const approved = db.prepare(`
      SELECT * FROM content
      WHERE status = 'approved'
        AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
      ORDER BY created_at ASC
      LIMIT 3
    `).all() as any[];

    for (const item of approved) {
      try {
        const client = getPlatformClient(item.platform, this.config);
        if (!client) {
          this.log.warn({ platform: item.platform }, 'No platform client available');
          continue;
        }

        const postId = await client.post({
          content: item.body,
          title: item.title,
          hashtags: JSON.parse(item.hashtags || '[]'),
          mediaUrls: JSON.parse(item.media_urls || '[]'),
        });

        db.prepare(`
          UPDATE content
          SET status = 'published', published_at = datetime('now'), platform_post_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(postId || 'posted', item.id);

        this.log.info({ platform: item.platform, title: item.title, postId }, 'Content published');
      } catch (err: any) {
        db.prepare(`
          UPDATE content SET status = 'failed', updated_at = datetime('now') WHERE id = ?
        `).run(item.id);

        this.log.error({ err, platform: item.platform }, 'Failed to post content');

        // Alert ops about failure
        this.sendMessage('ops', 'alert', {
          type: 'post_failure',
          platform: item.platform,
          error: err.message,
        }, 2);
      }
    }
  }

  private async fetchEngagement(): Promise<void> {
    const db = getSqlite();
    const published = db.prepare(`
      SELECT * FROM content
      WHERE status = 'published' AND platform_post_id IS NOT NULL
      ORDER BY published_at DESC
      LIMIT 10
    `).all() as any[];

    for (const item of published) {
      try {
        const client = getPlatformClient(item.platform, this.config);
        if (!client || !client.getEngagement) continue;

        const engagement = await client.getEngagement(item.platform_post_id);
        if (engagement) {
          db.prepare(`
            UPDATE content SET engagement = ?, updated_at = datetime('now') WHERE id = ?
          `).run(JSON.stringify(engagement), item.id);
        }
      } catch (err) {
        this.log.debug({ err, platform: item.platform }, 'Failed to fetch engagement');
      }
    }
  }

  private getPostCount(period: string): number {
    const db = getSqlite();
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM content
      WHERE status = 'published' AND published_at >= date('now')
    `).get() as any;
    return row?.count || 0;
  }

  private getPendingCount(): number {
    const db = getSqlite();
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM content WHERE status IN ('approved', 'pending_approval')
    `).get() as any;
    return row?.count || 0;
  }
}

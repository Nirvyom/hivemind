import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class ContentAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('content', 'Content', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    const tasks = messages.filter(m => m.type === 'task' && m.payload.type === 'create_content');

    if (tasks.length > 0) {
      for (const task of tasks) {
        await this.generateContent(task.payload);
        this.markMessageProcessed(task.id);
      }
    } else {
      // Autonomous mode: check if we need content
      await this.checkAndGenerateContent();
    }

    // Send report to CEO
    const stats = this.getContentStats();
    this.sendMessage('ceo', 'report', {
      agent: 'content',
      stats,
    });
  }

  private getProductContext(productName?: string): string {
    const products = (this.config.products || []).filter(p => p.active);
    if (products.length === 0) return '';

    if (productName) {
      const product = products.find(p => p.name === productName);
      if (product) {
        const tiers = product.pricing.map(t => `${t.name}: $${t.price}/${t.billingCycle}`).join(', ');
        return `\nFeatured Product: ${product.name}
Description: ${product.description}
Pricing: ${tiers || 'Custom'}
Key Deliverables: ${product.deliverables.join(', ')}
Features: ${product.pricing.flatMap(t => t.features).join(', ')}`;
      }
    }

    return '\nAvailable Products:\n' + products.map(p => {
      const tiers = p.pricing.map(t => `${t.name}: $${t.price}/${t.billingCycle}`).join(', ');
      return `- ${p.name}: ${p.description} (${tiers || 'Custom pricing'})`;
    }).join('\n');
  }

  private async generateContent(directive: any): Promise<void> {
    const { weeklyTheme, directives } = directive;

    for (const dir of directives || []) {
      const platform = dir.platform || 'linkedin';
      const type = dir.type || 'post';
      const productContext = this.getProductContext(dir.product);

      const systemPrompt = `You are a content creator for ${this.config.company.name}.
Company: ${this.config.company.description}
Services: ${this.config.company.services.join(', ')}
Brand voice: ${this.config.brand.voiceTone}
Tagline: ${this.config.brand.tagline || 'N/A'}
${productContext}

Create engaging ${platform} content that markets specific products when available.
Reference real features, pricing, and use cases. Output valid JSON only.`;

      const platformLimits: Record<string, string> = {
        linkedin: 'LinkedIn post (max 3000 chars, professional tone, use line breaks)',
        twitter: 'Tweet (max 280 chars, punchy and concise)',
        instagram: 'Instagram caption (engaging, with emoji suggestions, 2200 char max)',
        youtube: 'YouTube video description (SEO optimized, with timestamps format)',
      };

      const userPrompt = `Create a ${platformLimits[platform] || type} about: ${dir.topic}
Weekly theme: ${weeklyTheme || 'general business'}
${dir.product ? `Promote this product specifically: ${dir.product}` : ''}

Return JSON:
{
  "title": "string - post title/hook",
  "body": "string - full post content (reference specific product features and pricing when relevant)",
  "hashtags": ["relevant", "hashtags"],
  "mediaDescription": "string - suggested image/video description"
}`;

      try {
        const response = await this.askLLM(systemPrompt, userPrompt, { json: true });
        let parsed: any;
        try {
          parsed = JSON.parse(response.content);
        } catch {
          parsed = { title: dir.topic, body: response.content, hashtags: [], mediaDescription: '' };
        }

        // Store content in database
        const db = getSqlite();
        db.prepare(`
          INSERT INTO content (type, platform, title, body, hashtags, status, strategy_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, datetime('now'), datetime('now'))
        `).run(
          type,
          platform,
          parsed.title,
          parsed.body,
          JSON.stringify(parsed.hashtags || []),
          weeklyTheme || null,
        );

        this.log.info({ platform, type, title: parsed.title }, 'Content generated');

        // Notify social agent about new content
        this.sendMessage('social', 'task', {
          type: 'schedule_content',
          platform,
          contentTitle: parsed.title,
        });
      } catch (err: any) {
        this.log.error({ err, platform }, 'Failed to generate content');
      }
    }
  }

  private async checkAndGenerateContent(): Promise<void> {
    const db = getSqlite();
    const pendingCount = (db.prepare(
      "SELECT COUNT(*) as count FROM content WHERE status IN ('draft', 'pending_approval', 'approved')"
    ).get() as any).count;

    // If we have fewer than 5 pieces of pending content, generate more
    if (pendingCount < 5) {
      const enabledPlatforms = this.config.socialAccounts
        .filter(a => a.enabled && !['notion', 'telegram'].includes(a.platform))
        .map(a => a.platform);

      if (enabledPlatforms.length === 0) return;

      const platform = enabledPlatforms[Math.floor(Math.random() * enabledPlatforms.length)];

      // Prefer featuring a specific product
      const activeProducts = (this.config.products || []).filter(p => p.active);
      const product = activeProducts.length > 0
        ? activeProducts[Math.floor(Math.random() * activeProducts.length)]
        : null;

      const topic = product
        ? `${product.name} — ${product.deliverables[0] || product.description}`
        : this.config.company.services[Math.floor(Math.random() * this.config.company.services.length)];

      await this.generateContent({
        weeklyTheme: 'Thought leadership',
        directives: [{
          platform,
          type: 'post',
          topic,
          product: product?.name,
        }],
      });
    }
  }

  private getContentStats() {
    const db = getSqlite();
    const stats = db.prepare(`
      SELECT status, COUNT(*) as count FROM content GROUP BY status
    `).all() as any[];
    return Object.fromEntries(stats.map(s => [s.status, s.count]));
  }
}

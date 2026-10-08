import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class CompetitorAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('competitor', 'Competitor Intelligence', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      this.markMessageProcessed(msg.id);
    }

    await this.trackCompetitors();
    await this.analyzeCompetitorChanges();

    // Weekly competitive report (on Fridays)
    if (new Date().getDay() === 5) {
      await this.generateCompetitiveReport();
    }

    const stats = this.getCompetitorStats();
    this.sendMessage('ceo', 'report', { agent: 'competitor', stats });
  }

  private async trackCompetitors(): Promise<void> {
    const db = getSqlite();
    const configCompetitors = this.config.competitors || [];

    for (const comp of configCompetitors) {
      const existing = db.prepare(
        'SELECT id FROM competitors WHERE name = ?'
      ).get(comp.name);

      if (!existing) {
        db.prepare(`
          INSERT INTO competitors (name, website, category, created_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(comp.name, comp.website, comp.category || null);

        this.log.info({ competitor: comp.name }, 'New competitor tracked');
      }
    }
  }

  private async analyzeCompetitorChanges(): Promise<void> {
    const db = getSqlite();

    // Find competitors that haven't been analyzed recently
    const staleCompetitors = db.prepare(`
      SELECT * FROM competitors
      WHERE last_analyzed_at IS NULL OR last_analyzed_at < datetime('now', '-7 days')
      ORDER BY last_analyzed_at ASC NULLS FIRST
      LIMIT 3
    `).all() as any[];

    for (const comp of staleCompetitors) {
      try {
        const productContext = (this.config.products || [])
          .filter(p => p.active)
          .map(p => `${p.name}: ${p.description} (${p.pricing.map(t => `$${t.price}/${t.billingCycle}`).join(', ')})`)
          .join('\n');

        const response = await this.askLLM(
          `You are a competitive intelligence analyst for ${this.config.company.name}.
Our company: ${this.config.company.description}
Our services: ${this.config.company.services.join(', ')}
Our products:
${productContext || 'No structured products.'}

Analyze the competitor and provide strategic intelligence. Output valid JSON.`,
          `Analyze this competitor:
Name: ${comp.name}
Website: ${comp.website || 'N/A'}
Category: ${comp.category || 'N/A'}
Known products: ${comp.products || 'N/A'}
Previous pricing notes: ${comp.pricing_notes || 'N/A'}

Return JSON:
{
  "positioning": "how they position themselves",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1"],
  "estimatedPricing": "pricing analysis",
  "threats": ["threat to our business"],
  "opportunities": ["opportunity for us"],
  "recommendation": "strategic recommendation"
}`,
          { json: true }
        );

        let analysis: any;
        try {
          analysis = JSON.parse(response.content);
        } catch {
          this.log.warn({ competitor: comp.name }, 'Failed to parse competitor analysis');
          continue;
        }

        // Update competitor record
        db.prepare(`
          UPDATE competitors SET
            description = ?,
            pricing_notes = ?,
            last_analyzed_at = datetime('now')
          WHERE id = ?
        `).run(analysis.positioning, analysis.estimatedPricing, comp.id);

        // Store analysis report
        db.prepare(`
          INSERT INTO competitor_reports (competitor_id, period, analysis, threats, opportunities, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(
          comp.id,
          new Date().toISOString().slice(0, 10),
          JSON.stringify(analysis),
          JSON.stringify(analysis.threats),
          JSON.stringify(analysis.opportunities)
        );

        // Alert on significant threats
        if (analysis.threats && analysis.threats.length > 0) {
          await this.alertOnThreats(comp.name, analysis.threats);
        }

        this.log.info({ competitor: comp.name }, 'Competitor analyzed');
      } catch (err: any) {
        this.log.error({ err, competitor: comp.name }, 'Failed to analyze competitor');
      }
    }
  }

  private async alertOnThreats(competitorName: string, threats: string[]): Promise<void> {
    this.sendMessage('ceo', 'alert', {
      type: 'competitive_threat',
      competitor: competitorName,
      threats,
    }, 1);

    this.sendMessage('sales', 'alert', {
      type: 'competitive_intel',
      competitor: competitorName,
      threats,
      message: `Competitor ${competitorName} poses threats: ${threats.join('; ')}`,
    });
  }

  private async generateCompetitiveReport(): Promise<void> {
    const db = getSqlite();

    const allCompetitors = db.prepare('SELECT * FROM competitors').all() as any[];
    const recentReports = db.prepare(`
      SELECT cr.*, c.name as competitor_name
      FROM competitor_reports cr
      JOIN competitors c ON cr.competitor_id = c.id
      WHERE cr.created_at >= datetime('now', '-7 days')
      ORDER BY cr.created_at DESC
    `).all() as any[];

    if (allCompetitors.length === 0) return;

    const reportData = recentReports.map(r => {
      const analysis = r.analysis ? JSON.parse(r.analysis) : {};
      return {
        competitor: r.competitor_name,
        positioning: analysis.positioning,
        threats: r.threats ? JSON.parse(r.threats) : [],
        opportunities: r.opportunities ? JSON.parse(r.opportunities) : [],
      };
    });

    try {
      const response = await this.askLLM(
        `You are a competitive intelligence analyst for ${this.config.company.name}. Generate a weekly competitive landscape summary.`,
        `Generate a competitive landscape report based on:
Competitors tracked: ${allCompetitors.map(c => c.name).join(', ')}
Recent analyses: ${JSON.stringify(reportData)}

Provide a concise executive summary (5-7 bullet points) covering:
1. Key competitive moves
2. Threats to address
3. Opportunities to pursue
4. Recommended strategic actions`
      );

      this.sendMessage('ceo', 'report', {
        type: 'weekly_competitive_report',
        summary: response.content,
        competitorsTracked: allCompetitors.length,
        recentAnalyses: recentReports.length,
      });

      this.log.info('Weekly competitive report generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate competitive report');
    }
  }

  private getCompetitorStats() {
    const db = getSqlite();
    const total = (db.prepare('SELECT COUNT(*) as c FROM competitors').get() as any).c;
    const analyzed = (db.prepare(
      'SELECT COUNT(*) as c FROM competitors WHERE last_analyzed_at IS NOT NULL'
    ).get() as any).c;
    return { totalCompetitors: total, analyzed };
  }
}

import { getSqlite } from '../db/index.js';
import { callLLM, callLLMWithFallback, recordLLMCost, type LLMMessage, type LLMResponse } from '../llm/index.js';
import type { HivemindConfig } from '../config/schema.js';
import { getAgentLogger } from '../utils/logger.js';
import type pino from 'pino';

export type AgentName = 'ceo' | 'content' | 'social' | 'sales' | 'client' | 'ops' | 'hr' | 'finance' | 'legal' | 'billing' | 'procurement' | 'analytics' | 'email_campaign' | 'support' | 'competitor' | 'pipeline' | 'engagement' | 'collections' | 'briefing';

export interface AgentMessage {
  id: number;
  fromAgent: string;
  toAgent: string;
  type: string;
  payload: any;
  priority: number;
}

export abstract class BaseAgent {
  readonly name: AgentName;
  readonly displayName: string;
  protected config: HivemindConfig;
  protected log: pino.Logger;
  protected runId: number | null = null;

  constructor(name: AgentName, displayName: string, config: HivemindConfig) {
    this.name = name;
    this.displayName = displayName;
    this.config = config;
    this.log = getAgentLogger(name);
  }

  async tick(): Promise<void> {
    const startedAt = new Date().toISOString();
    const db = getSqlite();

    // Record run start
    const result = db.prepare(`
      INSERT INTO agent_runs (agent, status, started_at) VALUES (?, 'running', ?)
    `).run(this.name, startedAt);
    this.runId = Number(result.lastInsertRowid);

    this.log.info({ runId: this.runId }, `${this.displayName} tick started`);
    this.audit('tick_start', 'agent_run', this.runId, { startedAt });

    try {
      // Read pending messages
      const messages = this.readMessages();

      // Execute agent logic
      await this.execute(messages);

      // Mark run complete
      db.prepare(`
        UPDATE agent_runs SET status = 'completed', completed_at = datetime('now')
        WHERE id = ?
      `).run(this.runId);

      this.audit('tick_complete', 'agent_run', this.runId, { status: 'completed' });
      this.log.info({ runId: this.runId }, `${this.displayName} tick completed`);
    } catch (error: any) {
      db.prepare(`
        UPDATE agent_runs SET status = 'failed', completed_at = datetime('now'), error = ?
        WHERE id = ?
      `).run(error.message, this.runId);

      this.audit('tick_fail', 'agent_run', this.runId, { error: error.message });
      this.log.error({ err: error, runId: this.runId }, `${this.displayName} tick failed`);
    }
  }

  protected abstract execute(messages: AgentMessage[]): Promise<void>;

  protected audit(
    action: string,
    entityType: string,
    entityId: number | string | null,
    details: Record<string, any> = {},
    cost: number = 0
  ): void {
    try {
      const db = getSqlite();
      db.prepare(`
        INSERT INTO audit_log (timestamp, agent, action, entity_type, entity_id, details, cost)
        VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)
      `).run(
        this.name,
        action,
        entityType,
        entityId != null ? String(entityId) : null,
        JSON.stringify(details),
        cost
      );
    } catch {
      // Audit logging should never break agent execution
    }
  }

  protected async askLLM(
    systemPrompt: string,
    userPrompt: string,
    options: { temperature?: number; maxTokens?: number; json?: boolean } = {}
  ): Promise<LLMResponse> {
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const fallbacks = this.config.llmFallbacks || [];
    const response = fallbacks.length > 0
      ? await callLLMWithFallback(this.config.llm, fallbacks, messages, options)
      : await callLLM(this.config.llm, messages, options);

    // Track cost
    if (response.cost > 0) {
      recordLLMCost(response.cost, `${this.displayName} agent call`);
      this.updateRunCost(response.tokensUsed.input + response.tokensUsed.output, response.cost);
    }

    this.audit('llm_call', 'llm', null, {
      model: this.config.llm.model,
      tokensInput: response.tokensUsed.input,
      tokensOutput: response.tokensUsed.output,
      provider: (response as any).provider || this.config.llm.provider,
    }, response.cost);

    return response;
  }

  protected sendMessage(
    toAgent: string,
    type: string,
    payload: any,
    priority: number = 0
  ): void {
    const db = getSqlite();
    const result = db.prepare(`
      INSERT INTO messages (from_agent, to_agent, type, payload, priority, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(this.name, toAgent, type, JSON.stringify(payload), priority);

    this.audit('send_message', 'message', Number(result.lastInsertRowid), {
      toAgent, type, priority,
    });

    this.log.info({ toAgent, type }, 'Message sent');
  }

  protected readMessages(): AgentMessage[] {
    const db = getSqlite();
    const rows = db.prepare(`
      SELECT id, from_agent, to_agent, type, payload, priority
      FROM messages
      WHERE (to_agent = ? OR to_agent = 'broadcast') AND status = 'pending'
      ORDER BY priority DESC, created_at ASC
    `).all(this.name) as any[];

    // Mark as read
    for (const row of rows) {
      db.prepare(`UPDATE messages SET status = 'read' WHERE id = ?`).run(row.id);
    }

    return rows.map(r => ({
      id: r.id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      type: r.type,
      payload: JSON.parse(r.payload),
      priority: r.priority,
    }));
  }

  protected markMessageProcessed(messageId: number): void {
    const db = getSqlite();
    db.prepare(`
      UPDATE messages SET status = 'processed', processed_at = datetime('now') WHERE id = ?
    `).run(messageId);
  }

  private updateRunCost(tokens: number, cost: number): void {
    if (this.runId) {
      const db = getSqlite();
      db.prepare(`
        UPDATE agent_runs SET tokens_used = COALESCE(tokens_used, 0) + ?, cost = COALESCE(cost, 0) + ?
        WHERE id = ?
      `).run(tokens, cost, this.runId);
    }
  }

  getLastRun(): { status: string; completedAt: string; summary?: string } | null {
    const db = getSqlite();
    const row = db.prepare(`
      SELECT status, completed_at, summary FROM agent_runs
      WHERE agent = ? ORDER BY id DESC LIMIT 1
    `).get(this.name) as any;

    return row ? {
      status: row.status,
      completedAt: row.completed_at,
      summary: row.summary,
    } : null;
  }
}

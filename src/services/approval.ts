import { getSqlite } from '../db/index.js';
import { TelegramClient } from '../platforms/telegram.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('approval');

export interface ApprovalRequest {
  type: 'reply' | 'proposal' | 'payment_link' | 'follow_up' | 'pricing_change';
  entityType: 'lead' | 'client' | 'invoice';
  entityId?: string;
  agent: string;
  title: string;
  summary: string;
  draftContent?: string;
  actionData?: Record<string, any>;
  priority?: number;
  expiresIn?: string;
}

export interface Approval {
  id: number;
  type: string;
  entityType: string;
  entityId: string | null;
  agent: string;
  title: string;
  summary: string;
  draftContent: string | null;
  actionData: string | null;
  status: string;
  priority: number;
  telegramMessageId: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
}

function parseExpiryDuration(duration: string): Date {
  const now = new Date();
  const match = duration.match(/^(\d+)(h|d|m)$/);
  if (!match) {
    now.setHours(now.getHours() + 24);
    return now;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm': now.setMinutes(now.getMinutes() + value); break;
    case 'h': now.setHours(now.getHours() + value); break;
    case 'd': now.setDate(now.getDate() + value); break;
  }
  return now;
}

export async function createApproval(
  request: ApprovalRequest,
  config: HivemindConfig
): Promise<number> {
  const db = getSqlite();

  const expiresIn = request.expiresIn || config.approvals?.defaultExpiry || '24h';
  const expiresAt = parseExpiryDuration(expiresIn).toISOString();

  // Check auto-approve
  const autoApproveTypes = config.approvals?.autoApproveTypes || [];
  const shouldAutoApprove = autoApproveTypes.includes(request.type);

  const result = db.prepare(`
    INSERT INTO approvals (type, entity_type, entity_id, agent, title, summary, draft_content, action_data, status, priority, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    request.type,
    request.entityType,
    request.entityId || null,
    request.agent,
    request.title,
    request.summary,
    request.draftContent || null,
    request.actionData ? JSON.stringify(request.actionData) : null,
    shouldAutoApprove ? 'approved' : 'pending',
    request.priority || 3,
    expiresAt
  );

  const approvalId = Number(result.lastInsertRowid);

  if (shouldAutoApprove) {
    db.prepare(`
      UPDATE approvals SET reviewed_by = 'auto', reviewed_at = datetime('now') WHERE id = ?
    `).run(approvalId);
    log.info({ approvalId, type: request.type }, 'Auto-approved');
    return approvalId;
  }

  // Send Telegram approval message
  try {
    const telegram = new TelegramClient(config);
    if (telegram.isConfigured) {
      const chatId = config.telegram?.chatId || '';
      const priorityLabel = request.priority === 1 ? '\u{1f534} URGENT' :
        request.priority === 2 ? '\u{1f7e0} HIGH' : '\u{1f7e2} NORMAL';

      const message = [
        `<b>${priorityLabel} — ${request.title}</b>`,
        '',
        `<b>Type:</b> ${request.type}`,
        `<b>Agent:</b> ${request.agent}`,
        `<b>Entity:</b> ${request.entityType}${request.entityId ? ` #${request.entityId}` : ''}`,
        '',
        request.summary,
        '',
        request.draftContent ? `<b>Draft:</b>\n${request.draftContent.substring(0, 500)}${request.draftContent.length > 500 ? '...' : ''}` : '',
      ].filter(Boolean).join('\n');

      const messageId = await telegram.sendApprovalMessage(chatId, message, approvalId);
      if (messageId) {
        db.prepare('UPDATE approvals SET telegram_message_id = ? WHERE id = ?')
          .run(messageId, approvalId);
      }
    }
  } catch (err) {
    log.error({ err, approvalId }, 'Failed to send Telegram approval message');
  }

  log.info({ approvalId, type: request.type, agent: request.agent }, 'Approval created');
  return approvalId;
}

export async function processApprovalResponse(
  approvalId: number,
  approved: boolean,
  reviewedBy: string,
  reviewNote: string | null,
  config: HivemindConfig
): Promise<void> {
  const db = getSqlite();

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Approval | undefined;
  if (!approval) throw new Error(`Approval ${approvalId} not found`);
  if (approval.status !== 'pending') throw new Error(`Approval ${approvalId} already ${approval.status}`);

  const newStatus = approved ? 'approved' : 'rejected';
  db.prepare(`
    UPDATE approvals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, reviewedBy, reviewNote, approvalId);

  // Update Telegram message to show result
  try {
    const telegram = new TelegramClient(config);
    if (telegram.isConfigured && approval.telegramMessageId) {
      const chatId = config.telegram?.chatId || '';
      const statusEmoji = approved ? '\u2705' : '\u274c';
      const statusText = approved ? 'APPROVED' : 'REJECTED';
      await telegram.editMessageText(
        chatId,
        approval.telegramMessageId,
        `${statusEmoji} <b>${statusText}</b> — ${approval.title}\n\nBy: ${reviewedBy}${reviewNote ? `\nNote: ${reviewNote}` : ''}`
      );
    }
  } catch (err) {
    log.error({ err, approvalId }, 'Failed to update Telegram message');
  }

  log.info({ approvalId, status: newStatus, reviewedBy }, 'Approval processed');
}

export function getPendingApprovals(agent?: string): Approval[] {
  const db = getSqlite();
  if (agent) {
    return db.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' AND agent = ? ORDER BY priority ASC, created_at ASC"
    ).all(agent) as Approval[];
  }
  return db.prepare(
    "SELECT * FROM approvals WHERE status = 'pending' ORDER BY priority ASC, created_at ASC"
  ).all() as Approval[];
}

export function getApprovalById(id: number): Approval | undefined {
  const db = getSqlite();
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined;
}

export function getApprovedActions(agent: string): Approval[] {
  const db = getSqlite();
  return db.prepare(
    "SELECT * FROM approvals WHERE status = 'approved' AND agent = ? ORDER BY reviewed_at ASC"
  ).all(agent) as Approval[];
}

export function markApprovalExecuted(approvalId: number): void {
  const db = getSqlite();
  db.prepare("UPDATE approvals SET status = 'executed' WHERE id = ?").run(approvalId);
}

export function expireOldApprovals(): number {
  const db = getSqlite();
  const result = db.prepare(`
    UPDATE approvals SET status = 'expired'
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run();
  return result.changes;
}

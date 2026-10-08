import { TelegramClient } from '../platforms/telegram.js';
import { processApprovalResponse, getPendingApprovals } from './approval.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('telegram-bot');

export class TelegramBotService {
  private client: TelegramClient;
  private config: HivemindConfig;
  private offset: number | undefined;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: HivemindConfig) {
    this.config = config;
    this.client = new TelegramClient(config);
  }

  start(): void {
    if (!this.client.isConfigured) {
      log.info('Telegram not configured, bot service not starting');
      return;
    }

    this.running = true;
    log.info('Telegram bot polling service started');
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('Telegram bot polling service stopped');
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.client.pollUpdates(this.offset);

      for (const update of updates) {
        this.offset = update.update_id + 1;

        if (update.callback_query) {
          await this.handleCallbackQuery(update.callback_query);
        } else if (update.message?.text?.startsWith('/')) {
          await this.handleCommand(update.message);
        }
      }
    } catch (err) {
      log.error({ err }, 'Telegram polling error');
    }

    this.pollTimer = setTimeout(() => this.poll(), 2000);
  }

  private async handleCallbackQuery(query: any): Promise<void> {
    const data = query.data as string;
    const chatId = String(query.message?.chat?.id || '');

    try {
      if (data.startsWith('approve:') || data.startsWith('reject:')) {
        const [action, idStr] = data.split(':');
        const approvalId = parseInt(idStr, 10);
        const approved = action === 'approve';

        const userName = query.from?.first_name || query.from?.username || 'founder';

        await processApprovalResponse(approvalId, approved, userName, null, this.config);
        await this.client.answerCallbackQuery(
          query.id,
          approved ? 'Approved!' : 'Rejected!'
        );
      }
    } catch (err: any) {
      log.error({ err, data }, 'Failed to handle callback query');
      await this.client.answerCallbackQuery(query.id, `Error: ${err.message}`);
    }
  }

  private async handleCommand(message: any): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text as string;
    const command = text.split(' ')[0].toLowerCase();

    try {
      switch (command) {
        case '/status': {
          const db = getSqlite();
          const pendingApprovals = (db.prepare(
            "SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'"
          ).get() as any).c;

          const pipelineCounts = db.prepare(
            "SELECT stage, COUNT(*) as c FROM leads WHERE stage IS NOT NULL GROUP BY stage"
          ).all() as any[];

          let statusText = '<b>Hivemind Status</b>\n\n';
          statusText += `<b>Pending Approvals:</b> ${pendingApprovals}\n\n`;

          if (pipelineCounts.length > 0) {
            statusText += '<b>Pipeline:</b>\n';
            for (const row of pipelineCounts) {
              statusText += `  ${row.stage}: ${row.c}\n`;
            }
          }

          await this.client.sendMessage(chatId, statusText, 'HTML');
          break;
        }

        case '/pipeline': {
          const db = getSqlite();
          const stages = ['enquiry', 'qualified', 'responded', 'proposal_sent', 'negotiating', 'won', 'lost', 'dormant'];
          let pipelineText = '<b>Sales Pipeline</b>\n\n';

          for (const stage of stages) {
            const count = (db.prepare(
              'SELECT COUNT(*) as c FROM leads WHERE stage = ?'
            ).get(stage) as any).c;
            if (count > 0) {
              pipelineText += `<b>${stage}:</b> ${count}\n`;
            }
          }

          await this.client.sendMessage(chatId, pipelineText || 'Pipeline is empty.', 'HTML');
          break;
        }

        case '/pending': {
          const approvals = getPendingApprovals();
          if (approvals.length === 0) {
            await this.client.sendPlainMessage(chatId, 'No pending approvals.');
            break;
          }

          let pendingText = `<b>Pending Approvals (${approvals.length})</b>\n\n`;
          for (const a of approvals.slice(0, 10)) {
            pendingText += `#${a.id} [${a.type}] ${a.title}\n`;
          }
          if (approvals.length > 10) {
            pendingText += `\n... and ${approvals.length - 10} more`;
          }

          await this.client.sendMessage(chatId, pendingText, 'HTML');
          break;
        }

        default:
          // Ignore unknown commands
          break;
      }
    } catch (err) {
      log.error({ err, command }, 'Failed to handle bot command');
    }
  }
}

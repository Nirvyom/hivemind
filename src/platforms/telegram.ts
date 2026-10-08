import type { PlatformClient, PostContent } from './base.js';
import type { HivemindConfig } from '../config/schema.js';

export class TelegramClient implements PlatformClient {
  readonly platform = 'telegram';
  private config: HivemindConfig;
  private botToken: string;
  private defaultChatId: string;
  private baseUrl: string;

  constructor(config: HivemindConfig) {
    this.config = config;
    this.botToken = config.telegram?.botToken || '';
    this.defaultChatId = config.telegram?.chatId || '';
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  get isConfigured(): boolean {
    return !!(this.config.telegram?.botToken && this.config.telegram?.chatId);
  }

  async authenticate(): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('Telegram bot token or chat ID not configured');
    }
    const res = await fetch(`${this.baseUrl}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram auth failed: ${data.description}`);
    }
  }

  async post(content: PostContent): Promise<string | null> {
    const text = content.title
      ? `*${escapeMarkdown(content.title)}*\n\n${escapeMarkdown(content.content)}`
      : escapeMarkdown(content.content);
    const result = await this.sendMessage(this.defaultChatId, text);
    return result ? String(result) : null;
  }

  async sendMessage(chatId: string, text: string, parseMode: string = 'MarkdownV2'): Promise<number | null> {
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      // Retry without parse mode if markdown fails
      if (parseMode !== 'None') {
        return this.sendMessage(chatId, text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, ''), 'None');
      }
      throw new Error(`Telegram sendMessage failed: ${data.description}`);
    }

    return data.result?.message_id || null;
  }

  async sendAlert(text: string): Promise<number | null> {
    const formatted = `\u26a0\ufe0f *ALERT*\n\n${escapeMarkdown(text)}`;
    return this.sendMessage(this.defaultChatId, formatted);
  }

  async sendPlainMessage(chatId: string, text: string): Promise<number | null> {
    return this.sendMessage(chatId, text, 'None');
  }

  async pollUpdates(offset?: number): Promise<any[]> {
    const params = new URLSearchParams({ timeout: '5' });
    if (offset !== undefined) params.set('offset', String(offset));

    const res = await fetch(`${this.baseUrl}/getUpdates?${params}`);
    const data = await res.json();

    if (!data.ok) return [];
    return data.result || [];
  }

  async sendApprovalMessage(chatId: string, text: string, approvalId: number): Promise<number | null> {
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '\u2705 Approve', callback_data: `approve:${approvalId}` },
            { text: '\u274c Reject', callback_data: `reject:${approvalId}` },
          ]],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      // Retry without HTML parse mode
      const retryRes = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/<[^>]*>/g, ''),
          reply_markup: {
            inline_keyboard: [[
              { text: '\u2705 Approve', callback_data: `approve:${approvalId}` },
              { text: '\u274c Reject', callback_data: `reject:${approvalId}` },
            ]],
          },
        }),
      });
      const retryData = await retryRes.json();
      return retryData.result?.message_id || null;
    }

    return data.result?.message_id || null;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text || 'Done',
      }),
    });
  }

  async editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup?: any): Promise<void> {
    await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup || { inline_keyboard: [] },
      }),
    });
  }

  async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: any): Promise<void> {
    await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

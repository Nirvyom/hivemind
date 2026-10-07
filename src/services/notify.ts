import type { HivemindConfig } from '../config/schema.js';
import { TelegramClient } from '../platforms/telegram.js';

export type NotificationType = 'alert' | 'digest' | 'approval_request' | 'report';

export interface NotifyOptions {
  urgent?: boolean;
  subject?: string;
}

export async function notifyFounder(
  config: HivemindConfig,
  type: NotificationType,
  message: string,
  options: NotifyOptions = {}
): Promise<void> {
  const founder = config.founder;
  if (!founder) return;

  const channel = founder.preferredChannel || 'email';

  const prefix = type === 'alert' ? '[ALERT]'
    : type === 'digest' ? '[DIGEST]'
    : type === 'approval_request' ? '[APPROVAL NEEDED]'
    : '[REPORT]';

  const fullMessage = `${prefix} ${message}`;

  if (channel === 'telegram') {
    await notifyViaTelegram(config, type, fullMessage);
  } else {
    await notifyViaEmail(config, type, fullMessage, options);
  }
}

async function notifyViaTelegram(
  config: HivemindConfig,
  type: NotificationType,
  message: string
): Promise<void> {
  if (!config.telegram?.botToken || !config.telegram?.chatId) return;

  const telegram = new TelegramClient(config);
  const chatId = config.founder?.telegramChatId || config.telegram.chatId;

  if (type === 'alert') {
    await telegram.sendAlert(message);
  } else {
    await telegram.sendPlainMessage(chatId, message);
  }
}

async function notifyViaEmail(
  config: HivemindConfig,
  type: NotificationType,
  message: string,
  options: NotifyOptions = {}
): Promise<void> {
  const founder = config.founder;
  if (!founder?.email) return;

  const subject = options.subject || `Hivemind ${type}: ${config.company.name}`;

  // Use company email (SMTP) if configured
  if (config.companyEmail) {
    await sendViaSmtp(config, founder.email, subject, message);
    return;
  }

  // Fall back to existing email provider (Resend/Gmail)
  if (config.email?.provider === 'resend' && config.email.apiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.fromAddress || 'noreply@example.com',
        to: founder.email,
        subject,
        text: message,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to send email via Resend: ${res.status}`);
    }
  }
}

async function sendViaSmtp(
  config: HivemindConfig,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const email = config.companyEmail;
  if (!email) return;

  // Use nodemailer-style SMTP sending via raw net/tls if available,
  // or fall back to a simple fetch-based approach.
  // For now, we use the Resend/Gmail fallback if available, since
  // nodemailer is not a dependency. The SMTP credentials are stored
  // for future use when a mail transport is added.
  if (config.email?.provider === 'resend' && config.email.apiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: email.address,
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to send email via SMTP fallback: ${res.status}`);
    }
  }
}

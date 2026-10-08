import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import crypto from 'node:crypto';

const log = getLogger('razorpay');

export interface PaymentLinkOptions {
  amount: number; // in smallest currency unit (paise for INR)
  currency?: string;
  description: string;
  customer?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  referenceId?: string;
  expireBy?: number; // unix timestamp
}

export interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  amount: number;
  currency: string;
  status: string;
}

export class RazorpayService {
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;
  private baseUrl = 'https://api.razorpay.com/v1';

  constructor(config: HivemindConfig) {
    this.keyId = config.razorpay?.keyId || '';
    this.keySecret = config.razorpay?.keySecret || '';
    this.webhookSecret = config.razorpay?.webhookSecret || '';
  }

  get isConfigured(): boolean {
    return !!(this.keyId && this.keySecret);
  }

  private getAuthHeader(): string {
    return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
  }

  async createPaymentLink(options: PaymentLinkOptions): Promise<RazorpayPaymentLink> {
    if (!this.isConfigured) {
      throw new Error('Razorpay not configured');
    }

    const body: any = {
      amount: options.amount,
      currency: options.currency || 'INR',
      description: options.description,
      accept_partial: false,
    };

    if (options.customer) {
      body.customer = options.customer;
    }
    if (options.referenceId) {
      body.reference_id = options.referenceId;
    }
    if (options.expireBy) {
      body.expire_by = options.expireBy;
    }

    const res = await fetch(`${this.baseUrl}/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.getAuthHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Razorpay createPaymentLink failed: ${res.status} ${error}`);
    }

    const data = await res.json() as RazorpayPaymentLink;
    log.info({ linkId: data.id, amount: data.amount }, 'Payment link created');
    return data;
  }

  async getPaymentLink(linkId: string): Promise<RazorpayPaymentLink> {
    if (!this.isConfigured) {
      throw new Error('Razorpay not configured');
    }

    const res = await fetch(`${this.baseUrl}/payment_links/${linkId}`, {
      headers: {
        'Authorization': this.getAuthHeader(),
      },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Razorpay getPaymentLink failed: ${res.status} ${error}`);
    }

    return await res.json() as RazorpayPaymentLink;
  }

  verifyWebhookSignature(body: string, signature: string): boolean {
    if (!this.webhookSecret) return false;

    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(body)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSig)
    );
  }
}

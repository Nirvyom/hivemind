import { z } from 'zod';

export const SocialAccountSchema = z.object({
  platform: z.enum(['linkedin', 'twitter', 'instagram', 'youtube', 'notion', 'telegram']),
  enabled: z.boolean().default(false),
  authMethod: z.enum(['api_key', 'oauth']).optional(),
  credentials: z.record(z.string()).optional(),
  handle: z.string().optional(),
});

export const BrandAssetsSchema = z.object({
  logoPath: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  tagline: z.string().optional(),
  voiceTone: z.enum(['professional', 'casual', 'technical', 'friendly', 'bold']).default('professional'),
});

export const LLMProviderSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'ollama']),
  apiKey: z.string().optional(),
  model: z.string(),
  baseUrl: z.string().optional(),
});

export const BudgetSchema = z.object({
  monthlyLimit: z.number().min(0),
  currentSpend: z.number().default(0),
  alertThreshold: z.number().default(0.8),
  currency: z.string().default('USD'),
});

export const PricingTierSchema = z.object({
  name: z.string(),
  price: z.number(),
  currency: z.string().default('USD'),
  billingCycle: z.enum(['one-time', 'monthly', 'quarterly', 'yearly']).default('monthly'),
  features: z.array(z.string()).default([]),
});

export const ProductSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  category: z.string().optional(),
  pricing: z.array(PricingTierSchema).default([]),
  deliverables: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});

export const NotionConfigSchema = z.object({
  apiKey: z.string(),
  workspaceId: z.string().optional(),
  databases: z.record(z.string()).default({}), // purpose -> databaseId mapping
});

export const TelegramConfigSchema = z.object({
  botToken: z.string(),
  chatId: z.string(), // founder's chat ID
  enabled: z.boolean().default(true),
});

export const CompanyEmailSchema = z.object({
  address: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number().default(587),
  imapHost: z.string().optional(),
  imapPort: z.number().default(993).optional(),
  password: z.string(),
});

export const FounderContactSchema = z.object({
  name: z.string(),
  email: z.string(),
  telegramChatId: z.string().optional(),
  preferredChannel: z.enum(['telegram', 'email']).default('email'),
});

export const CompanyConfigSchema = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  description: z.string(),
  services: z.array(z.string()),
  targetAudience: z.string().optional(),
  governmentRegistration: z.object({
    registrationNumber: z.string().optional(),
    country: z.string().optional(),
    type: z.string().optional(),
  }).optional(),
});

export const ApiConfigSchema = z.object({
  port: z.number().default(9474),
  enabled: z.boolean().default(false),
  authToken: z.string().optional(),
});

export const CompetitorSchema = z.object({
  name: z.string(),
  website: z.string(),
  category: z.string().optional(),
});

export const RazorpayConfigSchema = z.object({
  keyId: z.string().default(''),
  keySecret: z.string().default(''),
  webhookSecret: z.string().default(''),
}).default({});

export const ApprovalsConfigSchema = z.object({
  defaultExpiry: z.string().default('24h'),
  autoApproveTypes: z.array(z.string()).default([]),
}).default({});

export const BriefingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  time: z.string().default('09:00'),
  channel: z.string().default('telegram'),
}).default({});

export const WhatsAppConfigSchema = z.object({
  webhookVerifyToken: z.string().default(''),
  enabled: z.boolean().default(false),
}).default({});

export const LegacyAgentsConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).default({});

export const HivemindConfigSchema = z.object({
  version: z.string().default('0.1.0'),
  company: CompanyConfigSchema,
  socialAccounts: z.array(SocialAccountSchema).default([]),
  brand: BrandAssetsSchema.default({}),
  llm: LLMProviderSchema,
  llmFallbacks: z.array(LLMProviderSchema).default([]),
  budget: BudgetSchema,
  products: z.array(ProductSchema).default([]),
  notion: NotionConfigSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
  companyEmail: CompanyEmailSchema.optional(),
  founder: FounderContactSchema.optional(),
  stripe: z.object({
    secretKey: z.string().optional(),
    webhookSecret: z.string().optional(),
  }).optional(),
  email: z.object({
    provider: z.enum(['resend', 'gmail']).optional(),
    apiKey: z.string().optional(),
    fromAddress: z.string().optional(),
  }).optional(),
  daemon: z.object({
    port: z.number().default(9473),
    pidFile: z.string().default('hivemind.pid'),
  }).default({}),
  api: ApiConfigSchema.default({}),
  competitors: z.array(CompetitorSchema).default([]),
  razorpay: RazorpayConfigSchema,
  approvals: ApprovalsConfigSchema,
  briefing: BriefingConfigSchema,
  whatsapp: WhatsAppConfigSchema,
  legacyAgents: LegacyAgentsConfigSchema,
  serviceCategories: z.array(z.string()).default([
    'web-development', 'mobile-app', 'design', 'marketing', 'consulting', 'custom',
  ]),
  defaultCurrency: z.string().default('INR'),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type HivemindConfig = z.infer<typeof HivemindConfigSchema>;
export type SocialAccount = z.infer<typeof SocialAccountSchema>;
export type CompanyConfig = z.infer<typeof CompanyConfigSchema>;
export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type BrandAssets = z.infer<typeof BrandAssetsSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type PricingTier = z.infer<typeof PricingTierSchema>;
export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type CompanyEmail = z.infer<typeof CompanyEmailSchema>;
export type FounderContact = z.infer<typeof FounderContactSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type Competitor = z.infer<typeof CompetitorSchema>;
export type RazorpayConfig = z.infer<typeof RazorpayConfigSchema>;
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;
export type BriefingConfig = z.infer<typeof BriefingConfigSchema>;
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;
export type LegacyAgentsConfig = z.infer<typeof LegacyAgentsConfigSchema>;

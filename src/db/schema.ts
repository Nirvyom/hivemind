import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const company = sqliteTable('company', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  domain: text('domain'),
  industry: text('industry'),
  description: text('description').notNull(),
  services: text('services').notNull(), // JSON array
  targetAudience: text('target_audience'),
  registrationNumber: text('registration_number'),
  country: text('country'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const leads = sqliteTable('leads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email'),
  company: text('company'),
  linkedinUrl: text('linkedin_url'),
  source: text('source').notNull(), // 'inbound' | 'outbound'
  status: text('status').notNull().default('new'), // new, contacted, qualified, proposal, closed_won, closed_lost
  score: integer('score').default(0),
  notes: text('notes'),
  lastContactedAt: text('last_contacted_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const clients = sqliteTable('clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id').references(() => leads.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  company: text('company'),
  stripeCustomerId: text('stripe_customer_id'),
  contractValue: real('contract_value'),
  status: text('status').notNull().default('active'), // active, paused, churned
  signedAt: text('signed_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const content = sqliteTable('content', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // post, article, video_script, story, reel
  platform: text('platform').notNull(), // linkedin, twitter, instagram, youtube
  title: text('title'),
  body: text('body').notNull(),
  mediaUrls: text('media_urls'), // JSON array
  hashtags: text('hashtags'), // JSON array
  status: text('status').notNull().default('draft'), // draft, pending_approval, approved, published, failed
  scheduledFor: text('scheduled_for'),
  publishedAt: text('published_at'),
  platformPostId: text('platform_post_id'),
  engagement: text('engagement'), // JSON: { likes, comments, shares, impressions }
  strategyRef: text('strategy_ref'), // Reference to CEO strategy that generated this
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const transactions = sqliteTable('transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // revenue, expense
  category: text('category').notNull(), // llm_cost, platform_fee, invoice_payment, stripe_fee
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  description: text('description'),
  stripeInvoiceId: text('stripe_invoice_id'),
  clientId: integer('client_id').references(() => clients.id),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromAgent: text('from_agent').notNull(),
  toAgent: text('to_agent').notNull(), // or 'broadcast'
  type: text('type').notNull(), // task, report, alert, strategy, approval_request
  payload: text('payload').notNull(), // JSON
  status: text('status').notNull().default('pending'), // pending, read, processed
  priority: integer('priority').default(0), // higher = more urgent
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  processedAt: text('processed_at'),
});

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agent: text('agent').notNull(),
  status: text('status').notNull(), // running, completed, failed
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  tokensUsed: integer('tokens_used').default(0),
  cost: real('cost').default(0),
  summary: text('summary'),
  error: text('error'),
});

export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category'),
  pricing: text('pricing').notNull(), // JSON array of pricing tiers
  deliverables: text('deliverables').notNull(), // JSON array
  active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const platformAuth = sqliteTable('platform_auth', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull().unique(),
  authMethod: text('auth_method').notNull(), // api_key, oauth
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiry: text('token_expiry'),
  scopes: text('scopes'), // JSON array
  metadata: text('metadata'), // JSON - platform-specific data
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

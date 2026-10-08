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
  referralId: integer('referral_id'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  // Revenue Execution OS columns
  phone: text('phone'),
  channel: text('channel').default('manual'),
  requirements: text('requirements'),
  budgetRange: text('budget_range'),
  urgency: text('urgency').default('normal'),
  serviceFitScore: integer('service_fit_score'),
  nextAction: text('next_action'),
  nextActionDue: text('next_action_due'),
  stage: text('stage').default('enquiry'), // enquiry → qualified → responded → proposal_sent → negotiating → won → lost → dormant
  qualifiedAt: text('qualified_at'),
  proposalSentAt: text('proposal_sent_at'),
  wonAt: text('won_at'),
  lostReason: text('lost_reason'),
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

// ── HR Tables ──

export const employees = sqliteTable('employees', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentName: text('agent_name').notNull().unique(),
  displayName: text('display_name').notNull(),
  department: text('department').notNull(),
  role: text('role').notNull(),
  reportsTo: text('reports_to'),
  status: text('status').notNull().default('active'),
  hiredAt: text('hired_at').notNull().default('CURRENT_TIMESTAMP'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const performanceReviews = sqliteTable('performance_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentName: text('agent_name').notNull(),
  reviewPeriod: text('review_period').notNull(),
  totalRuns: integer('total_runs').default(0),
  successfulRuns: integer('successful_runs').default(0),
  failedRuns: integer('failed_runs').default(0),
  totalTokens: integer('total_tokens').default(0),
  totalCost: real('total_cost').default(0),
  avgRunDurationSeconds: real('avg_run_duration_seconds'),
  performanceScore: integer('performance_score'),
  llmSummary: text('llm_summary'),
  recommendations: text('recommendations'),
  reviewedAt: text('reviewed_at').notNull().default('CURRENT_TIMESTAMP'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const policies = sqliteTable('policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  category: text('category').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('active'),
  approvedBy: text('approved_by'),
  effectiveDate: text('effective_date'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Finance Tables ──

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  parentCode: text('parent_code'),
  balance: real('balance').notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  description: text('description'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const journalEntries = sqliteTable('journal_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryDate: text('entry_date').notNull().default('CURRENT_TIMESTAMP'),
  description: text('description').notNull(),
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  debitAccount: text('debit_account').notNull(),
  creditAccount: text('credit_account').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  postedBy: text('posted_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const budgets = sqliteTable('budgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  department: text('department').notNull(),
  period: text('period').notNull(),
  allocatedAmount: real('allocated_amount').notNull(),
  spentAmount: real('spent_amount').notNull().default(0),
  category: text('category'),
  notes: text('notes'),
  approvedBy: text('approved_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const financialReports = sqliteTable('financial_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  period: text('period').notNull(),
  data: text('data').notNull(),
  generatedBy: text('generated_by').notNull().default('finance'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Legal Tables ──

export const contracts = sqliteTable('contracts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  type: text('type').notNull(),
  counterparty: text('counterparty'),
  counterpartyType: text('counterparty_type'),
  clientId: integer('client_id').references(() => clients.id),
  vendorId: integer('vendor_id'),
  body: text('body').notNull(),
  value: real('value'),
  currency: text('currency').default('USD'),
  status: text('status').notNull().default('draft'),
  effectiveDate: text('effective_date'),
  expiryDate: text('expiry_date'),
  signedAt: text('signed_at'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const complianceItems = sqliteTable('compliance_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  category: text('category').notNull(),
  description: text('description'),
  status: text('status').notNull().default('pending'),
  dueDate: text('due_date'),
  assignedTo: text('assigned_to'),
  resolution: text('resolution'),
  priority: integer('priority').default(0),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const legalDocuments = sqliteTable('legal_documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  type: text('type').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('draft'),
  approvedBy: text('approved_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Billing Tables ──

export const invoices = sqliteTable('invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceNumber: text('invoice_number').notNull().unique(),
  clientId: integer('client_id').notNull().references(() => clients.id),
  contractId: integer('contract_id').references(() => contracts.id),
  amount: real('amount').notNull(),
  taxAmount: real('tax_amount').default(0),
  totalAmount: real('total_amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('draft'),
  dueDate: text('due_date'),
  paidAt: text('paid_at'),
  stripeInvoiceId: text('stripe_invoice_id'),
  lineItems: text('line_items').notNull(),
  notes: text('notes'),
  sentAt: text('sent_at'),
  reminderCount: integer('reminder_count').default(0),
  lastReminderAt: text('last_reminder_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  productName: text('product_name').notNull(),
  tierName: text('tier_name'),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  billingCycle: text('billing_cycle').notNull(),
  status: text('status').notNull().default('active'),
  startDate: text('start_date').notNull(),
  nextBillingDate: text('next_billing_date'),
  cancelledAt: text('cancelled_at'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const paymentRecords = sqliteTable('payment_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id').references(() => invoices.id),
  clientId: integer('client_id').references(() => clients.id),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  paymentMethod: text('payment_method'),
  status: text('status').notNull().default('pending'),
  stripePaymentId: text('stripe_payment_id'),
  transactionId: integer('transaction_id').references(() => transactions.id),
  paidAt: text('paid_at'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Procurement Tables ──

export const vendors = sqliteTable('vendors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  contactEmail: text('contact_email'),
  category: text('category'),
  website: text('website'),
  status: text('status').notNull().default('active'),
  contractId: integer('contract_id').references(() => contracts.id),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const purchaseOrders = sqliteTable('purchase_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  poNumber: text('po_number').notNull().unique(),
  vendorId: integer('vendor_id').notNull().references(() => vendors.id),
  description: text('description').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('draft'),
  approvedBy: text('approved_by'),
  approvedAt: text('approved_at'),
  category: text('category'),
  requestedBy: text('requested_by'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const subscriptionsOutgoing = sqliteTable('subscriptions_outgoing', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vendorId: integer('vendor_id').notNull().references(() => vendors.id),
  serviceName: text('service_name').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  billingCycle: text('billing_cycle').notNull(),
  status: text('status').notNull().default('active'),
  category: text('category'),
  renewalDate: text('renewal_date'),
  autoRenew: integer('auto_renew').default(1),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
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

// ── Infrastructure Tables ──

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull().default('CURRENT_TIMESTAMP'),
  agent: text('agent').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  details: text('details'), // JSON
  cost: real('cost').default(0),
});

export const webhookEvents = sqliteTable('webhook_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(), // JSON
  status: text('status').notNull().default('pending'), // pending, processed, failed
  processedBy: text('processed_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  processedAt: text('processed_at'),
});

// ── Analytics Tables ──

export const analyticsSnapshots = sqliteTable('analytics_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  period: text('period').notNull(),
  metricType: text('metric_type').notNull(),
  data: text('data').notNull(), // JSON
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const attributionEvents = sqliteTable('attribution_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventType: text('event_type').notNull(),
  sourceType: text('source_type').notNull(), // content, platform, campaign
  sourceId: integer('source_id'),
  leadId: integer('lead_id').references(() => leads.id),
  clientId: integer('client_id').references(() => clients.id),
  revenue: real('revenue').default(0),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Email Campaign Tables ──

export const emailCampaigns = sqliteTable('email_campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // drip, newsletter, blast
  status: text('status').notNull().default('draft'), // draft, active, paused, completed
  subject: text('subject'),
  body: text('body'),
  template: text('template'),
  audienceSegment: text('audience_segment'),
  scheduledFor: text('scheduled_for'),
  sentCount: integer('sent_count').default(0),
  openCount: integer('open_count').default(0),
  clickCount: integer('click_count').default(0),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const emailSequences = sqliteTable('email_sequences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => emailCampaigns.id),
  stepNumber: integer('step_number').notNull(),
  delayDays: integer('delay_days').notNull().default(0),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const emailSends = sqliteTable('email_sends', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').references(() => emailCampaigns.id),
  sequenceStep: integer('sequence_step'),
  recipientEmail: text('recipient_email').notNull(),
  leadId: integer('lead_id').references(() => leads.id),
  clientId: integer('client_id').references(() => clients.id),
  status: text('status').notNull().default('queued'), // queued, sent, opened, clicked, bounced
  sentAt: text('sent_at'),
  openedAt: text('opened_at'),
  clickedAt: text('clicked_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Support Tables ──

export const supportTickets = sqliteTable('support_tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketNumber: text('ticket_number').notNull().unique(),
  clientId: integer('client_id').references(() => clients.id),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  category: text('category'),
  priority: integer('priority').notNull().default(3), // 1-5
  status: text('status').notNull().default('open'), // open, in_progress, waiting, resolved, closed
  assignedTo: text('assigned_to'),
  slaDeadline: text('sla_deadline'),
  resolution: text('resolution'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  resolvedAt: text('resolved_at'),
});

export const ticketMessages = sqliteTable('ticket_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => supportTickets.id),
  sender: text('sender').notNull(), // client, agent, system
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const knowledgeBase = sqliteTable('knowledge_base', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  category: text('category'),
  content: text('content').notNull(),
  embeddingText: text('embedding_text'),
  tags: text('tags'), // JSON array
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Competitor Tables ──

export const competitors = sqliteTable('competitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  website: text('website'),
  description: text('description'),
  category: text('category'),
  products: text('products'), // JSON
  pricingNotes: text('pricing_notes'),
  lastAnalyzedAt: text('last_analyzed_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const competitorReports = sqliteTable('competitor_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  competitorId: integer('competitor_id').references(() => competitors.id),
  period: text('period').notNull(),
  analysis: text('analysis'), // JSON
  threats: text('threats'),
  opportunities: text('opportunities'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Revenue Intelligence Tables ──

export const churnSignals = sqliteTable('churn_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  signalType: text('signal_type').notNull(),
  severity: integer('severity').notNull().default(1), // 1-5
  details: text('details'),
  detectedAt: text('detected_at').notNull().default('CURRENT_TIMESTAMP'),
  resolvedAt: text('resolved_at'),
});

export const referrals = sqliteTable('referrals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  referrerClientId: integer('referrer_client_id').references(() => clients.id),
  referredLeadId: integer('referred_lead_id').references(() => leads.id),
  referredClientId: integer('referred_client_id').references(() => clients.id),
  status: text('status').notNull().default('pending'), // pending, converted, paid
  commissionAmount: real('commission_amount'),
  commissionPaidAt: text('commission_paid_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// ── Revenue Execution OS Tables ──

export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // 'reply' | 'proposal' | 'payment_link' | 'follow_up' | 'pricing_change'
  entityType: text('entity_type').notNull(), // 'lead' | 'client' | 'invoice'
  entityId: text('entity_id'),
  agent: text('agent').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  draftContent: text('draft_content'),
  actionData: text('action_data'), // JSON
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected' | 'expired'
  priority: integer('priority').default(3), // 1=urgent, 5=low
  telegramMessageId: integer('telegram_message_id'),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  reviewedAt: text('reviewed_at'),
  expiresAt: text('expires_at'),
});

export const opportunityActivities = sqliteTable('opportunity_activities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id').notNull(),
  activityType: text('activity_type').notNull(), // 'email_sent' | 'call' | 'whatsapp' | 'meeting' | 'proposal_sent' | 'follow_up' | 'payment_link_sent' | 'note'
  direction: text('direction'), // 'inbound' | 'outbound'
  channel: text('channel'), // 'email' | 'whatsapp' | 'telegram' | 'phone' | 'form' | 'manual'
  subject: text('subject'),
  body: text('body'),
  metadata: text('metadata'), // JSON
  createdBy: text('created_by'), // agent name or 'founder'
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
});

export const proposalTemplates = sqliteTable('proposal_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category'),
  templateBody: text('template_body').notNull(), // markdown/HTML with {{variables}}
  scopeItems: text('scope_items'), // JSON array of {item, description, unit, rate}
  terms: text('terms'),
  validityDays: integer('validity_days').default(15),
  status: text('status').default('active'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at'),
});

export const rateCards = sqliteTable('rate_cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceCategory: text('service_category').notNull(),
  item: text('item').notNull(),
  description: text('description'),
  unit: text('unit').default('project'), // 'hour' | 'day' | 'project' | 'month'
  rateAmount: real('rate_amount').notNull(),
  currency: text('currency').default('INR'),
  status: text('status').default('active'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
});

export const followUpSequences = sqliteTable('follow_up_sequences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  triggerStage: text('trigger_stage').notNull(),
  steps: text('steps').notNull(), // JSON array of {delay_days, channel, template, action_level}
  status: text('status').default('active'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
});

export const dailyBriefings = sqliteTable('daily_briefings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(),
  pipelineSummary: text('pipeline_summary').notNull(), // JSON
  exceptions: text('exceptions').notNull(), // JSON array
  recommendations: text('recommendations').notNull(), // JSON array
  metrics: text('metrics').notNull(), // JSON {response_time, follow_up_rate, proposals_sent, etc.}
  deliveredVia: text('delivered_via'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
});

export const paymentLinks = sqliteTable('payment_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id'),
  clientId: integer('client_id'),
  invoiceId: integer('invoice_id'),
  razorpayLinkId: text('razorpay_link_id'),
  razorpayLinkUrl: text('razorpay_link_url'),
  amount: real('amount').notNull(),
  currency: text('currency').default('INR'),
  description: text('description'),
  status: text('status').default('created'), // 'created' | 'sent' | 'paid' | 'expired' | 'cancelled'
  expiresAt: text('expires_at'),
  paidAt: text('paid_at'),
  razorpayPaymentId: text('razorpay_payment_id'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
});

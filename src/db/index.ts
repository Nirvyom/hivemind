import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { paths, ensureDir } from '../config/index.js';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (!_db) {
    ensureDir();
    _sqlite = new Database(paths.db);
    _sqlite.pragma('journal_mode = WAL');
    _sqlite.pragma('foreign_keys = ON');
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

export function getSqlite(): Database.Database {
  if (!_sqlite) {
    getDb();
  }
  return _sqlite!;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export function initializeDatabase(): void {
  const sqlite = getSqlite();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS company (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      description TEXT NOT NULL,
      services TEXT NOT NULL,
      target_audience TEXT,
      registration_number TEXT,
      country TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      company TEXT,
      linkedin_url TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      score INTEGER DEFAULT 0,
      notes TEXT,
      last_contacted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      stripe_customer_id TEXT,
      contract_value REAL,
      status TEXT NOT NULL DEFAULT 'active',
      signed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      platform TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      media_urls TEXT,
      hashtags TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_for TEXT,
      published_at TEXT,
      platform_post_id TEXT,
      engagement TEXT,
      strategy_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT,
      stripe_invoice_id TEXT,
      client_id INTEGER REFERENCES clients(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      summary TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      pricing TEXT NOT NULL,
      deliverables TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_auth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL UNIQUE,
      auth_method TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry TEXT,
      scopes TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- HR Tables
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      department TEXT NOT NULL,
      role TEXT NOT NULL,
      reports_to TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      hired_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS performance_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      review_period TEXT NOT NULL,
      total_runs INTEGER DEFAULT 0,
      successful_runs INTEGER DEFAULT 0,
      failed_runs INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      avg_run_duration_seconds REAL,
      performance_score INTEGER,
      llm_summary TEXT,
      recommendations TEXT,
      reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      approved_by TEXT,
      effective_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Finance Tables
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_code TEXT,
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      debit_account TEXT NOT NULL,
      credit_account TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      posted_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT NOT NULL,
      period TEXT NOT NULL,
      allocated_amount REAL NOT NULL,
      spent_amount REAL NOT NULL DEFAULT 0,
      category TEXT,
      notes TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      period TEXT NOT NULL,
      data TEXT NOT NULL,
      generated_by TEXT NOT NULL DEFAULT 'finance',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Legal Tables
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      counterparty TEXT,
      counterparty_type TEXT,
      client_id INTEGER REFERENCES clients(id),
      vendor_id INTEGER,
      body TEXT NOT NULL,
      value REAL,
      currency TEXT DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'draft',
      effective_date TEXT,
      expiry_date TEXT,
      signed_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compliance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      due_date TEXT,
      assigned_to TEXT,
      resolution TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS legal_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      approved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Billing Tables
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      contract_id INTEGER REFERENCES contracts(id),
      amount REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      total_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'draft',
      due_date TEXT,
      paid_at TEXT,
      stripe_invoice_id TEXT,
      line_items TEXT NOT NULL,
      notes TEXT,
      sent_at TEXT,
      reminder_count INTEGER DEFAULT 0,
      last_reminder_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      product_name TEXT NOT NULL,
      tier_name TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TEXT NOT NULL,
      next_billing_date TEXT,
      cancelled_at TEXT,
      stripe_subscription_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER REFERENCES invoices(id),
      client_id INTEGER REFERENCES clients(id),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_payment_id TEXT,
      transaction_id INTEGER REFERENCES transactions(id),
      paid_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Procurement Tables
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_email TEXT,
      category TEXT,
      website TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      contract_id INTEGER REFERENCES contracts(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'draft',
      approved_by TEXT,
      approved_at TEXT,
      category TEXT,
      requested_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions_outgoing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      service_name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      category TEXT,
      renewal_date TEXT,
      auto_renew INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Infrastructure Tables
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      cost REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      processed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    -- Analytics Tables
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attribution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER,
      lead_id INTEGER REFERENCES leads(id),
      client_id INTEGER REFERENCES clients(id),
      revenue REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Email Campaign Tables
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      subject TEXT,
      body TEXT,
      template TEXT,
      audience_segment TEXT,
      scheduled_for TEXT,
      sent_count INTEGER DEFAULT 0,
      open_count INTEGER DEFAULT 0,
      click_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id),
      step_number INTEGER NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES email_campaigns(id),
      sequence_step INTEGER,
      recipient_email TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id),
      client_id INTEGER REFERENCES clients(id),
      status TEXT NOT NULL DEFAULT 'queued',
      sent_at TEXT,
      opened_at TEXT,
      clicked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Support Tables
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL UNIQUE,
      client_id INTEGER REFERENCES clients(id),
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to TEXT,
      sla_deadline TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      content TEXT NOT NULL,
      embedding_text TEXT,
      tags TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Competitor Tables
    CREATE TABLE IF NOT EXISTS competitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      website TEXT,
      description TEXT,
      category TEXT,
      products TEXT,
      pricing_notes TEXT,
      last_analyzed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS competitor_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id INTEGER REFERENCES competitors(id),
      period TEXT NOT NULL,
      analysis TEXT,
      threats TEXT,
      opportunities TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Revenue Intelligence Tables
    CREATE TABLE IF NOT EXISTS churn_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      signal_type TEXT NOT NULL,
      severity INTEGER NOT NULL DEFAULT 1,
      details TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_client_id INTEGER REFERENCES clients(id),
      referred_lead_id INTEGER REFERENCES leads(id),
      referred_client_id INTEGER REFERENCES clients(id),
      status TEXT NOT NULL DEFAULT 'pending',
      commission_amount REAL,
      commission_paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_content_status ON content(status);
    CREATE INDEX IF NOT EXISTS idx_content_platform ON content(platform);
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_employees_agent ON employees(agent_name);
    CREATE INDEX IF NOT EXISTS idx_performance_reviews_agent ON performance_reviews(agent_name);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_client ON subscriptions(client_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
    CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
    CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_client ON support_tickets(client_id);
    CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_sends(status);
    CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_churn_signals_client ON churn_signals(client_id);
    CREATE INDEX IF NOT EXISTS idx_competitors_name ON competitors(name);
    CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

    -- Revenue Execution OS Tables

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      agent TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      draft_content TEXT,
      action_data TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 3,
      telegram_message_id INTEGER,
      reviewed_by TEXT,
      review_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS opportunity_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      direction TEXT,
      channel TEXT,
      subject TEXT,
      body TEXT,
      metadata TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proposal_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      template_body TEXT NOT NULL,
      scope_items TEXT,
      terms TEXT,
      validity_days INTEGER DEFAULT 15,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rate_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_category TEXT NOT NULL,
      item TEXT NOT NULL,
      description TEXT,
      unit TEXT DEFAULT 'project',
      rate_amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follow_up_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_stage TEXT NOT NULL,
      steps TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      pipeline_summary TEXT NOT NULL,
      exceptions TEXT NOT NULL,
      recommendations TEXT NOT NULL,
      metrics TEXT NOT NULL,
      delivered_via TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      client_id INTEGER,
      invoice_id INTEGER,
      razorpay_link_id TEXT,
      razorpay_link_url TEXT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      description TEXT,
      status TEXT DEFAULT 'created',
      expires_at TEXT,
      paid_at TEXT,
      razorpay_payment_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent);
    CREATE INDEX IF NOT EXISTS idx_opportunity_activities_lead ON opportunity_activities(lead_id);
    CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links(status);
    CREATE INDEX IF NOT EXISTS idx_daily_briefings_date ON daily_briefings(date);
  `);

  // Add new columns to leads table (idempotent)
  const leadAlterColumns = [
    'phone TEXT',
    "channel TEXT DEFAULT 'manual'",
    'requirements TEXT',
    'budget_range TEXT',
    "urgency TEXT DEFAULT 'normal'",
    'service_fit_score INTEGER',
    'next_action TEXT',
    'next_action_due TEXT',
    "stage TEXT DEFAULT 'enquiry'",
    'qualified_at TEXT',
    'proposal_sent_at TEXT',
    'won_at TEXT',
    'lost_reason TEXT',
  ];

  for (const col of leadAlterColumns) {
    try {
      sqlite.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
    } catch {
      // Column already exists
    }
  }

  // Webhook idempotency column
  try {
    sqlite.exec(`ALTER TABLE webhook_events ADD COLUMN provider_event_id TEXT`);
  } catch {
    // Column already exists
  }

  // Webhook dedup index
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_provider_dedup
      ON webhook_events(source, provider_event_id)
      WHERE provider_event_id IS NOT NULL
  `);

  // Better approval lookups
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_approvals_agent_status
      ON approvals(agent, status)
  `);
}

export { schema };

import Database from 'better-sqlite3';
import { vi } from 'vitest';

const DDL = `
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

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    processed_by TEXT,
    provider_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_provider_dedup
    ON webhook_events(source, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_approvals_agent_status
    ON approvals(agent, status);

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    company TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    score INTEGER DEFAULT 0,
    notes TEXT,
    last_contacted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    phone TEXT,
    channel TEXT DEFAULT 'manual',
    requirements TEXT,
    budget_range TEXT,
    urgency TEXT DEFAULT 'normal',
    service_fit_score INTEGER,
    next_action TEXT,
    next_action_due TEXT,
    stage TEXT DEFAULT 'enquiry',
    qualified_at TEXT,
    proposal_sent_at TEXT,
    won_at TEXT,
    lost_reason TEXT
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

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    contract_id INTEGER,
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
`;

export function setupTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);

  // Patch the db module to return our in-memory instance
  vi.doMock('../../src/db/index.js', () => ({
    getSqlite: () => db,
    getDb: () => { throw new Error('Use getSqlite() in tests'); },
    closeDb: () => db.close(),
    initializeDatabase: () => {},
    schema: {},
  }));

  return {
    db,
    cleanup() {
      vi.doUnmock('../../src/db/index.js');
      db.close();
    },
  };
}

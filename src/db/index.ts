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

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_content_status ON content(status);
    CREATE INDEX IF NOT EXISTS idx_content_platform ON content(platform);
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  `);
}

export { schema };

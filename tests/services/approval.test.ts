import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from '../helpers/db.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let cleanup: () => void;

beforeEach(async () => {
  vi.resetModules();
  const testDb = setupTestDb();
  db = testDb.db;
  cleanup = testDb.cleanup;
});

afterEach(() => {
  cleanup();
});

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    company: { name: 'Test Co', description: 'test', services: ['dev'] },
    approvals: { defaultExpiry: '24h', autoApproveTypes: [], ...overrides.approvals },
    telegram: undefined,
    ...overrides,
  } as any;
}

describe('createApproval', () => {
  it('creates an approval successfully', async () => {
    const { createApproval } = await import('../../src/services/approval.js');

    const id = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Test approval',
      summary: 'Test summary',
    }, makeConfig());

    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
    expect(row.agent).toBe('pipeline');
    expect(row.type).toBe('reply');
  });

  it('prevents duplicate active approvals', async () => {
    const { createApproval } = await import('../../src/services/approval.js');
    const config = makeConfig();

    const id1 = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'First',
      summary: 'Summary',
    }, config);

    const id2 = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Duplicate',
      summary: 'Should be skipped',
    }, config);

    expect(id2).toBe(id1);

    const count = (db.prepare('SELECT COUNT(*) as c FROM approvals').get() as any).c;
    expect(count).toBe(1);
  });

  it('allows new approval after previous rejected', async () => {
    const { createApproval } = await import('../../src/services/approval.js');
    const config = makeConfig();

    const id1 = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'First',
      summary: 'Summary',
    }, config);

    // Reject the first one
    db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(id1);

    const id2 = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Second attempt',
      summary: 'Should succeed',
    }, config);

    expect(id2).not.toBe(id1);
    expect(id2).toBeGreaterThan(id1);
  });
});

describe('processApprovalResponse', () => {
  it('atomically approves a pending approval', async () => {
    const { createApproval, processApprovalResponse } = await import('../../src/services/approval.js');
    const config = makeConfig();

    const id = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Test',
      summary: 'Summary',
    }, config);

    await processApprovalResponse(id, true, 'admin', 'looks good', config);

    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    expect(row.status).toBe('approved');
    expect(row.reviewed_by).toBe('admin');
    expect(row.review_note).toBe('looks good');
  });

  it('throws on double-approve', async () => {
    const { createApproval, processApprovalResponse } = await import('../../src/services/approval.js');
    const config = makeConfig();

    const id = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Test',
      summary: 'Summary',
    }, config);

    await processApprovalResponse(id, true, 'admin', null, config);

    await expect(
      processApprovalResponse(id, true, 'admin2', null, config)
    ).rejects.toThrow(/already processed/);
  });
});

describe('markApprovalExecuted', () => {
  it('first call returns true, second returns false', async () => {
    const { createApproval, processApprovalResponse, markApprovalExecuted } =
      await import('../../src/services/approval.js');
    const config = makeConfig();

    const id = await createApproval({
      type: 'reply',
      entityType: 'lead',
      entityId: '1',
      agent: 'pipeline',
      title: 'Test',
      summary: 'Summary',
    }, config);

    await processApprovalResponse(id, true, 'admin', null, config);

    const first = markApprovalExecuted(id);
    expect(first).toBe(true);

    const second = markApprovalExecuted(id);
    expect(second).toBe(false);

    const row = db.prepare('SELECT status FROM approvals WHERE id = ?').get(id) as any;
    expect(row.status).toBe('executed');
  });
});

describe('expireOldApprovals', () => {
  it('expires approvals past their expiry date', async () => {
    const { expireOldApprovals } = await import('../../src/services/approval.js');

    // Insert an already-expired approval
    db.prepare(`
      INSERT INTO approvals (type, entity_type, entity_id, agent, title, summary, status, priority, created_at, expires_at)
      VALUES ('reply', 'lead', '1', 'pipeline', 'Old', 'Expired', 'pending', 3, datetime('now', '-2 days'), datetime('now', '-1 day'))
    `).run();

    const count = expireOldApprovals();
    expect(count).toBe(1);

    const row = db.prepare('SELECT status FROM approvals WHERE agent = ?').get('pipeline') as any;
    expect(row.status).toBe('expired');
  });
});

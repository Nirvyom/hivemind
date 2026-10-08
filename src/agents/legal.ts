import { BaseAgent, type AgentMessage } from './base.js';
import { getSqlite } from '../db/index.js';
import type { HivemindConfig } from '../config/schema.js';

export class LegalAgent extends BaseAgent {
  constructor(config: HivemindConfig) {
    super('legal', 'Legal', config);
  }

  protected async execute(messages: AgentMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.type === 'task') {
        switch (msg.payload.type) {
          case 'review_proposal':
            await this.reviewProposal(msg.payload);
            break;
          case 'generate_contract':
            await this.generateContract(msg.payload);
            break;
          case 'generate_nda':
            await this.generateNDA(msg.payload);
            break;
        }
      }
      this.markMessageProcessed(msg.id);
    }

    await this.checkExpiringContracts();
    await this.auditCompliance();
    await this.ensureStandardDocuments();

    // Report to CEO
    const stats = this.getLegalStats();
    this.sendMessage('ceo', 'report', { agent: 'legal', stats });
  }

  private async reviewProposal(payload: any): Promise<void> {
    const { leadId, proposal } = payload;

    try {
      const response = await this.askLLM(
        `You are General Counsel for ${this.config.company.name}.
Company: ${this.config.company.description}
${this.config.company.governmentRegistration?.country ? `Jurisdiction: ${this.config.company.governmentRegistration.country}` : ''}

Review proposals for legal risks. Output valid JSON only.`,
        `Review this proposal for legal risks:
${JSON.stringify(proposal, null, 2)}

Return JSON:
{
  "approved": true/false,
  "riskLevel": "low|medium|high",
  "issues": ["issue description"],
  "recommendations": ["recommendation"],
  "requiredClauses": ["clause that should be added to contract"],
  "notes": "brief legal opinion"
}`,
        { json: true }
      );

      let review: any;
      try {
        review = JSON.parse(response.content);
      } catch {
        review = { approved: true, riskLevel: 'low', issues: [], recommendations: [], notes: 'Unable to parse review.' };
      }

      // Send result back to client agent
      this.sendMessage('client', 'task', {
        type: 'review_result',
        leadId,
        approved: review.approved,
        riskLevel: review.riskLevel,
        issues: review.issues,
        recommendations: review.recommendations,
        requiredClauses: review.requiredClauses,
      }, 1);

      this.log.info({ leadId, approved: review.approved, risk: review.riskLevel }, 'Proposal reviewed');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to review proposal');
    }
  }

  private async generateContract(payload: any): Promise<void> {
    const { leadId, clientName, clientCompany, proposal } = payload;

    try {
      const response = await this.askLLM(
        `You are General Counsel for ${this.config.company.name}.
Company: ${this.config.company.description}
${this.config.company.governmentRegistration ? `Registration: ${this.config.company.governmentRegistration.registrationNumber || 'N/A'}, Country: ${this.config.company.governmentRegistration.country || 'N/A'}` : ''}

Generate legally sound service agreements. Output valid JSON only.`,
        `Generate a service agreement for:
Client: ${clientName} at ${clientCompany || 'their company'}
Scope: ${JSON.stringify(proposal?.scope || [])}
Value: $${proposal?.pricing?.total || 0}
Terms: ${proposal?.terms || 'Net 30'}

Return JSON:
{
  "title": "contract title",
  "body": "full contract text with numbered sections",
  "keyTerms": ["key term"],
  "value": 0
}`,
        { json: true }
      );

      let contract: any;
      try {
        contract = JSON.parse(response.content);
      } catch {
        this.log.warn('Failed to parse contract');
        return;
      }

      const db = getSqlite();
      db.prepare(`
        INSERT INTO contracts (title, type, counterparty, counterparty_type, body, value, status, created_at, updated_at)
        VALUES (?, 'service_agreement', ?, 'client', ?, ?, 'draft', datetime('now'), datetime('now'))
      `).run(contract.title, clientCompany || clientName, contract.body, contract.value || proposal?.pricing?.total || 0);

      // Notify client agent
      this.sendMessage('client', 'task', {
        type: 'contract_ready',
        leadId,
        contractTitle: contract.title,
        keyTerms: contract.keyTerms,
      }, 1);

      this.log.info({ title: contract.title }, 'Contract generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate contract');
    }
  }

  private async generateNDA(payload: any): Promise<void> {
    const { counterparty, counterpartyType } = payload;

    try {
      const response = await this.askLLM(
        `You are General Counsel for ${this.config.company.name}. Generate a mutual NDA. Output valid JSON only.`,
        `Generate a mutual NDA between ${this.config.company.name} and ${counterparty}.
Return JSON:
{
  "title": "NDA title",
  "body": "full NDA text"
}`,
        { json: true }
      );

      let nda: any;
      try {
        nda = JSON.parse(response.content);
      } catch { return; }

      const db = getSqlite();
      db.prepare(`
        INSERT INTO contracts (title, type, counterparty, counterparty_type, body, status, created_at, updated_at)
        VALUES (?, 'nda', ?, ?, ?, 'draft', datetime('now'), datetime('now'))
      `).run(nda.title, counterparty, counterpartyType || 'client', nda.body);

      this.log.info({ counterparty }, 'NDA generated');
    } catch (err: any) {
      this.log.error({ err }, 'Failed to generate NDA');
    }
  }

  private async checkExpiringContracts(): Promise<void> {
    const db = getSqlite();
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 86400000).toISOString();

    const expiring = db.prepare(`
      SELECT * FROM contracts
      WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= ?
    `).all(thirtyDaysFromNow) as any[];

    for (const contract of expiring) {
      this.sendMessage('ceo', 'alert', {
        type: 'contract_expiring',
        contractId: contract.id,
        title: contract.title,
        counterparty: contract.counterparty,
        expiryDate: contract.expiry_date,
        message: `Contract "${contract.title}" with ${contract.counterparty} expires on ${contract.expiry_date}.`,
      }, 1);

      this.sendMessage('client', 'alert', {
        type: 'contract_expiring',
        contractId: contract.id,
        title: contract.title,
        counterparty: contract.counterparty,
        expiryDate: contract.expiry_date,
      });
    }

    if (expiring.length > 0) {
      this.log.warn({ count: expiring.length }, 'Expiring contracts found');
    }
  }

  private async auditCompliance(): Promise<void> {
    const db = getSqlite();

    const requiredItems = [
      { title: 'Terms of Service Published', category: 'terms' },
      { title: 'Privacy Policy Published', category: 'data_privacy' },
      { title: 'Data Processing Agreement', category: 'data_privacy' },
    ];

    for (const item of requiredItems) {
      const existing = db.prepare(
        'SELECT id FROM compliance_items WHERE title = ?'
      ).get(item.title);
      if (existing) continue;

      db.prepare(`
        INSERT INTO compliance_items (title, category, status, assigned_to, priority, created_at, updated_at)
        VALUES (?, ?, 'pending', 'legal', 1, datetime('now'), datetime('now'))
      `).run(item.title, item.category);
    }

    // Check if standard docs exist
    const tosExists = db.prepare(
      "SELECT id FROM legal_documents WHERE type = 'policy' AND title LIKE '%Terms of Service%' AND status = 'approved'"
    ).get();
    if (tosExists) {
      db.prepare(
        "UPDATE compliance_items SET status = 'compliant', updated_at = datetime('now') WHERE title = 'Terms of Service Published'"
      ).run();
    }

    const privacyExists = db.prepare(
      "SELECT id FROM legal_documents WHERE type = 'policy' AND title LIKE '%Privacy Policy%' AND status = 'approved'"
    ).get();
    if (privacyExists) {
      db.prepare(
        "UPDATE compliance_items SET status = 'compliant', updated_at = datetime('now') WHERE title = 'Privacy Policy Published'"
      ).run();
    }
  }

  private async ensureStandardDocuments(): Promise<void> {
    const db = getSqlite();

    const docs = [
      { title: 'Terms of Service', type: 'policy' },
      { title: 'Privacy Policy', type: 'policy' },
    ];

    for (const doc of docs) {
      const existing = db.prepare(
        'SELECT id FROM legal_documents WHERE title = ? AND type = ?'
      ).get(doc.title, doc.type);
      if (existing) continue;

      try {
        const response = await this.askLLM(
          `You are General Counsel for ${this.config.company.name}. Generate a standard ${doc.title}. Output valid JSON only.`,
          `Generate a ${doc.title} for ${this.config.company.name}.
Company: ${this.config.company.description}
Domain: ${this.config.company.domain || 'N/A'}
Services: ${this.config.company.services.join(', ')}

Return JSON:
{
  "body": "full ${doc.title.toLowerCase()} text with sections"
}`,
          { json: true }
        );

        let parsed: any;
        try {
          parsed = JSON.parse(response.content);
        } catch { continue; }

        db.prepare(`
          INSERT INTO legal_documents (title, type, body, version, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'draft', datetime('now'), datetime('now'))
        `).run(doc.title, doc.type, parsed.body);

        this.log.info({ title: doc.title }, 'Standard document generated');
      } catch (err: any) {
        this.log.error({ err, title: doc.title }, 'Failed to generate standard document');
      }
    }
  }

  private getLegalStats() {
    const db = getSqlite();
    const contractCount = (db.prepare('SELECT COUNT(*) as count FROM contracts').get() as any).count;
    const activeContracts = (db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'active'").get() as any).count;
    const pendingCompliance = (db.prepare("SELECT COUNT(*) as count FROM compliance_items WHERE status = 'pending'").get() as any).count;
    const documentCount = (db.prepare('SELECT COUNT(*) as count FROM legal_documents').get() as any).count;

    return { totalContracts: contractCount, activeContracts, pendingCompliance, totalDocuments: documentCount };
  }
}

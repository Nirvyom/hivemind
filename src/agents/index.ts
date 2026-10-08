import type { HivemindConfig } from '../config/schema.js';
// Old agents — kept for DB compatibility but no longer scheduled
import { CEOAgent } from './ceo.js';
import { ContentAgent } from './content.js';
import { SocialAgent } from './social.js';
import { SalesAgent } from './sales.js';
import { ClientAgent } from './client.js';
import { OpsAgent } from './ops.js';
import { HRAgent } from './hr.js';
import { FinanceAgent } from './finance.js';
import { LegalAgent } from './legal.js';
import { BillingAgent } from './billing.js';
import { ProcurementAgent } from './procurement.js';
import { AnalyticsAgent } from './analytics.js';
import { EmailCampaignAgent } from './email_campaign.js';
import { SupportAgent } from './support.js';
import { CompetitorAgent } from './competitor.js';
// New Revenue Execution OS agents
import { PipelineAgent } from './pipeline.js';
import { EngagementAgent } from './engagement.js';
import { CollectionsAgent } from './collections.js';
import { BriefingAgent } from './briefing.js';
import type { BaseAgent, AgentName } from './base.js';

export interface AgentSchedule {
  agent: BaseAgent;
  cronExpression: string;
  interval: string;
}

export function createAgents(config: HivemindConfig): AgentSchedule[] {
  const schedules: AgentSchedule[] = [
    {
      agent: new PipelineAgent(config),
      cronExpression: '*/15 * * * *',   // Every 15 minutes
      interval: '15 minutes',
    },
    {
      agent: new EngagementAgent(config),
      cronExpression: '0 */2 * * *',    // Every 2 hours
      interval: '2 hours',
    },
    {
      agent: new CollectionsAgent(config),
      cronExpression: '0 * * * *',      // Every hour
      interval: '1 hour',
    },
    {
      agent: new BriefingAgent(config),
      cronExpression: '0 9 * * *',      // Daily at 9 AM
      interval: '1 day',
    },
  ];

  if (config.legacyAgents?.enabled) {
    schedules.push(
      { agent: new CEOAgent(config), cronExpression: '0 */6 * * *', interval: '6 hours' },
      { agent: new ContentAgent(config), cronExpression: '0 */4 * * *', interval: '4 hours' },
      { agent: new SocialAgent(config), cronExpression: '*/30 * * * *', interval: '30 minutes' },
      { agent: new SalesAgent(config), cronExpression: '0 */2 * * *', interval: '2 hours' },
      { agent: new ClientAgent(config), cronExpression: '0 * * * *', interval: '1 hour' },
      { agent: new OpsAgent(config), cronExpression: '*/15 * * * *', interval: '15 minutes' },
      { agent: new HRAgent(config), cronExpression: '0 9 * * 1', interval: 'weekly' },
      { agent: new FinanceAgent(config), cronExpression: '0 8 * * *', interval: 'daily' },
      { agent: new LegalAgent(config), cronExpression: '0 */6 * * *', interval: '6 hours' },
      { agent: new BillingAgent(config), cronExpression: '0 * * * *', interval: '1 hour' },
      { agent: new ProcurementAgent(config), cronExpression: '0 */4 * * *', interval: '4 hours' },
      { agent: new AnalyticsAgent(config), cronExpression: '0 */3 * * *', interval: '3 hours' },
      { agent: new EmailCampaignAgent(config), cronExpression: '0 */2 * * *', interval: '2 hours' },
      { agent: new SupportAgent(config), cronExpression: '*/30 * * * *', interval: '30 minutes' },
      { agent: new CompetitorAgent(config), cronExpression: '0 6 * * *', interval: 'daily' },
    );
  }

  return schedules;
}

export function getAgentByName(name: AgentName, config: HivemindConfig): BaseAgent {
  const agents: Record<AgentName, () => BaseAgent> = {
    // Old agents (still instantiable for ad-hoc use)
    ceo: () => new CEOAgent(config),
    content: () => new ContentAgent(config),
    social: () => new SocialAgent(config),
    sales: () => new SalesAgent(config),
    client: () => new ClientAgent(config),
    ops: () => new OpsAgent(config),
    hr: () => new HRAgent(config),
    finance: () => new FinanceAgent(config),
    legal: () => new LegalAgent(config),
    billing: () => new BillingAgent(config),
    procurement: () => new ProcurementAgent(config),
    analytics: () => new AnalyticsAgent(config),
    email_campaign: () => new EmailCampaignAgent(config),
    support: () => new SupportAgent(config),
    competitor: () => new CompetitorAgent(config),
    // New Revenue Execution OS agents
    pipeline: () => new PipelineAgent(config),
    engagement: () => new EngagementAgent(config),
    collections: () => new CollectionsAgent(config),
    briefing: () => new BriefingAgent(config),
  };

  const factory = agents[name];
  if (!factory) throw new Error(`Unknown agent: ${name}`);
  return factory();
}

export { BaseAgent, type AgentName } from './base.js';

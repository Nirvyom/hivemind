import type { HivemindConfig } from '../config/schema.js';
import { CEOAgent } from './ceo.js';
import { ContentAgent } from './content.js';
import { SocialAgent } from './social.js';
import { SalesAgent } from './sales.js';
import { ClientAgent } from './client.js';
import { OpsAgent } from './ops.js';
import type { BaseAgent, AgentName } from './base.js';

export interface AgentSchedule {
  agent: BaseAgent;
  cronExpression: string;
  interval: string;
}

export function createAgents(config: HivemindConfig): AgentSchedule[] {
  return [
    {
      agent: new CEOAgent(config),
      cronExpression: '0 */6 * * *',    // Every 6 hours
      interval: '6 hours',
    },
    {
      agent: new ContentAgent(config),
      cronExpression: '0 */4 * * *',    // Every 4 hours
      interval: '4 hours',
    },
    {
      agent: new SocialAgent(config),
      cronExpression: '*/30 * * * *',   // Every 30 minutes
      interval: '30 minutes',
    },
    {
      agent: new SalesAgent(config),
      cronExpression: '0 */2 * * *',    // Every 2 hours
      interval: '2 hours',
    },
    {
      agent: new ClientAgent(config),
      cronExpression: '0 * * * *',      // Every hour
      interval: '1 hour',
    },
    {
      agent: new OpsAgent(config),
      cronExpression: '*/15 * * * *',   // Every 15 minutes
      interval: '15 minutes',
    },
  ];
}

export function getAgentByName(name: AgentName, config: HivemindConfig): BaseAgent {
  const agents: Record<AgentName, () => BaseAgent> = {
    ceo: () => new CEOAgent(config),
    content: () => new ContentAgent(config),
    social: () => new SocialAgent(config),
    sales: () => new SalesAgent(config),
    client: () => new ClientAgent(config),
    ops: () => new OpsAgent(config),
  };

  const factory = agents[name];
  if (!factory) throw new Error(`Unknown agent: ${name}`);
  return factory();
}

export { BaseAgent, type AgentName } from './base.js';

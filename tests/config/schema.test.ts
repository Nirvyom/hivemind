import { describe, it, expect } from 'vitest';
import { HivemindConfigSchema } from '../../src/config/schema.js';

describe('HivemindConfigSchema', () => {
  const minimalConfig = {
    company: {
      name: 'Test Co',
      description: 'A test company',
      services: ['consulting'],
    },
    llm: {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-20250514',
    },
    budget: {
      monthlyLimit: 100,
    },
  };

  it('validates minimal config', () => {
    const result = HivemindConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  it('legacyAgents defaults to { enabled: false }', () => {
    const result = HivemindConfigSchema.parse(minimalConfig);
    expect(result.legacyAgents).toEqual({ enabled: false });
  });

  it('legacyAgents.enabled can be set to true', () => {
    const result = HivemindConfigSchema.parse({
      ...minimalConfig,
      legacyAgents: { enabled: true },
    });
    expect(result.legacyAgents.enabled).toBe(true);
  });

  it('approvals defaults correctly', () => {
    const result = HivemindConfigSchema.parse(minimalConfig);
    expect(result.approvals).toEqual({
      defaultExpiry: '24h',
      autoApproveTypes: [],
    });
  });

  it('razorpay defaults correctly', () => {
    const result = HivemindConfigSchema.parse(minimalConfig);
    expect(result.razorpay).toEqual({
      keyId: '',
      keySecret: '',
      webhookSecret: '',
    });
  });
});

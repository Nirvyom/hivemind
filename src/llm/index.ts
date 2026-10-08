import type { LLMProvider } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import { getSqlite } from '../db/index.js';

const log = getLogger('llm');

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: { input: number; output: number };
  cost: number;
  provider?: string;
}

// Cost per 1K tokens (approximate)
const COST_TABLE: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-haiku-4-20250414': { input: 0.0008, output: 0.004 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
};

function estimateCost(model: string, input: number, output: number): number {
  const rates = COST_TABLE[model] || { input: 0.001, output: 0.002 };
  return (input / 1000) * rates.input + (output / 1000) * rates.output;
}

// Track provider health for fallback decisions
const providerHealth: Map<string, { consecutiveFailures: number; lastFailure: number }> = new Map();

function getProviderKey(provider: LLMProvider): string {
  return `${provider.provider}:${provider.model}`;
}

function isProviderHealthy(provider: LLMProvider): boolean {
  const key = getProviderKey(provider);
  const health = providerHealth.get(key);
  if (!health) return true;
  // Skip providers with 3+ consecutive failures in the last 5 minutes
  if (health.consecutiveFailures >= 3 && Date.now() - health.lastFailure < 5 * 60 * 1000) {
    return false;
  }
  return true;
}

function recordProviderSuccess(provider: LLMProvider): void {
  const key = getProviderKey(provider);
  providerHealth.set(key, { consecutiveFailures: 0, lastFailure: 0 });
}

function recordProviderFailure(provider: LLMProvider): void {
  const key = getProviderKey(provider);
  const current = providerHealth.get(key) || { consecutiveFailures: 0, lastFailure: 0 };
  providerHealth.set(key, {
    consecutiveFailures: current.consecutiveFailures + 1,
    lastFailure: Date.now(),
  });
}

export async function callLLMWithFallback(
  primary: LLMProvider,
  fallbacks: LLMProvider[],
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; json?: boolean } = {}
): Promise<LLMResponse> {
  const allProviders = [primary, ...fallbacks];

  for (const provider of allProviders) {
    if (!isProviderHealthy(provider)) {
      log.warn({ provider: getProviderKey(provider) }, 'Skipping unhealthy provider');
      continue;
    }

    try {
      const response = await callLLM(provider, messages, options);
      recordProviderSuccess(provider);
      response.provider = provider.provider;
      return response;
    } catch (err: any) {
      recordProviderFailure(provider);
      log.error({ err, provider: getProviderKey(provider) }, 'LLM provider failed, trying fallback');
    }
  }

  throw new Error('All LLM providers failed');
}

export async function callLLM(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; json?: boolean } = {}
): Promise<LLMResponse> {
  const { temperature = 0.7, maxTokens = 2048, json = false } = options;

  switch (provider.provider) {
    case 'openai':
      return callOpenAI(provider, messages, { temperature, maxTokens, json });
    case 'anthropic':
      return callAnthropic(provider, messages, { temperature, maxTokens, json });
    case 'ollama':
      return callOllama(provider, messages, { temperature, maxTokens, json });
    default:
      throw new Error(`Unknown LLM provider: ${provider.provider}`);
  }
}

async function callOpenAI(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: { temperature: number; maxTokens: number; json: boolean }
): Promise<LLMResponse> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: provider.apiKey });

  const response = await client.chat.completions.create({
    model: provider.model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });

  const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0 };
  const cost = estimateCost(provider.model, usage.prompt_tokens, usage.completion_tokens);

  log.info({ model: provider.model, tokens: usage, cost }, 'OpenAI call completed');

  return {
    content: response.choices[0]?.message?.content || '',
    tokensUsed: { input: usage.prompt_tokens, output: usage.completion_tokens },
    cost,
  };
}

async function callAnthropic(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: { temperature: number; maxTokens: number; json: boolean }
): Promise<LLMResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: provider.apiKey });

  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const response = await client.messages.create({
    model: provider.model,
    max_tokens: opts.maxTokens,
    system: systemMsg,
    messages: userMessages,
    temperature: opts.temperature,
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cost = estimateCost(provider.model, inputTokens, outputTokens);

  log.info({ model: provider.model, tokens: { inputTokens, outputTokens }, cost }, 'Anthropic call completed');

  const textBlock = response.content.find(b => b.type === 'text');
  return {
    content: textBlock?.text || '',
    tokensUsed: { input: inputTokens, output: outputTokens },
    cost,
  };
}

async function callOllama(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: { temperature: number; maxTokens: number; json: boolean }
): Promise<LLMResponse> {
  const baseUrl = provider.baseUrl || 'http://localhost:11434';

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature,
        num_predict: opts.maxTokens,
      },
      ...(opts.json ? { format: 'json' } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;

  log.info({ model: provider.model }, 'Ollama call completed (free)');

  return {
    content: data.message?.content || '',
    tokensUsed: {
      input: data.prompt_eval_count || 0,
      output: data.eval_count || 0,
    },
    cost: 0, // Ollama is free
  };
}

export function recordLLMCost(cost: number, description: string): void {
  try {
    const sqlite = getSqlite();
    sqlite.prepare(`
      INSERT INTO transactions (type, category, amount, description, created_at)
      VALUES ('expense', 'llm_cost', ?, ?, datetime('now'))
    `).run(cost, description);
  } catch (err) {
    log.error({ err }, 'Failed to record LLM cost');
  }
}

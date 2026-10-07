import type { PlatformClient } from './base.js';
import type { HivemindConfig } from '../config/schema.js';
import { LinkedInClient } from './linkedin.js';
import { TwitterClient } from './twitter.js';
import { YouTubeClient } from './youtube.js';
import { InstagramClient } from './instagram.js';
import { NotionClient } from './notion.js';
import { TelegramClient } from './telegram.js';

const clientCache = new Map<string, PlatformClient>();

export function getPlatformClient(
  platform: string,
  config: HivemindConfig
): PlatformClient | null {
  if (clientCache.has(platform)) {
    return clientCache.get(platform)!;
  }

  let client: PlatformClient;
  switch (platform) {
    case 'linkedin':
      client = new LinkedInClient(config);
      break;
    case 'twitter':
      client = new TwitterClient(config);
      break;
    case 'youtube':
      client = new YouTubeClient(config);
      break;
    case 'instagram':
      client = new InstagramClient(config);
      break;
    case 'notion':
      client = new NotionClient(config);
      break;
    case 'telegram':
      client = new TelegramClient(config);
      break;
    default:
      return null;
  }

  // For social platforms, check if enabled in socialAccounts
  if (['linkedin', 'twitter', 'youtube', 'instagram'].includes(platform)) {
    const account = config.socialAccounts.find(a => a.platform === platform && a.enabled);
    if (!account) return null;
  }

  // For notion/telegram, check their dedicated config
  if (platform === 'notion' && !config.notion?.apiKey) return null;
  if (platform === 'telegram' && !config.telegram?.botToken) return null;

  clientCache.set(platform, client);
  return client;
}

export function clearPlatformCache(): void {
  clientCache.clear();
}

export type { PlatformClient, PostContent, Engagement } from './base.js';

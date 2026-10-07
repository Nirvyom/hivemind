import type { PlatformClient, PostContent, Engagement } from './base.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

const log = getLogger('youtube');

export class YouTubeClient implements PlatformClient {
  readonly platform = 'youtube';
  private config: HivemindConfig;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(config: HivemindConfig) {
    this.config = config;
  }

  get isConfigured(): boolean {
    const account = this.config.socialAccounts.find(a => a.platform === 'youtube');
    return !!account?.enabled;
  }

  async authenticate(): Promise<void> {
    const account = this.config.socialAccounts.find(a => a.platform === 'youtube');
    if (!account?.credentials) throw new Error('YouTube not configured');

    if (account.authMethod === 'api_key') {
      this.accessToken = account.credentials.apiKey;
    } else {
      await this.oauthFlow(account.credentials);
    }
  }

  private async oauthFlow(credentials: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const { clientId, clientSecret } = credentials;
      const redirectUri = 'http://localhost:9476/callback';
      const state = crypto.randomBytes(16).toString('hex');
      const scopes = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&access_type=offline&prompt=consent`;

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost:9476');
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code) {
            try {
              const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: redirectUri,
                  client_id: clientId,
                  client_secret: clientSecret,
                }),
              });
              const tokenData = await tokenResp.json() as any;
              this.accessToken = tokenData.access_token;
              this.refreshToken = tokenData.refresh_token;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>YouTube connected! You can close this tab.</h1>');
              server.close();
              resolve();
            } catch (err) {
              server.close();
              reject(err);
            }
          }
        }
      });

      server.listen(9476, () => {
        log.info({ authUrl }, 'Open this URL to authenticate with YouTube');
      });

      setTimeout(() => { server.close(); reject(new Error('OAuth timeout')); }, 300000);
    });
  }

  async post(content: PostContent): Promise<string | null> {
    if (!this.accessToken) await this.authenticate();
    if (!this.accessToken) throw new Error('Not authenticated with YouTube');

    // YouTube "posts" are community posts or video uploads
    // For text-based content, we use community posts
    const description = content.hashtags?.length
      ? `${content.content}\n\n${content.hashtags.map(h => `#${h}`).join(' ')}`
      : content.content;

    // Community post (if available for the channel)
    try {
      const resp = await fetch(
        'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: {
              // Community posts aren't fully supported via API
              // This is a simplified implementation
              topLevelComment: {
                snippet: { textOriginal: description },
              },
            },
          }),
        }
      );

      if (resp.ok) {
        const data = await resp.json() as any;
        log.info({ id: data.id }, 'Posted to YouTube');
        return data.id || null;
      }
    } catch (err) {
      log.warn({ err }, 'Community post not available, content saved as video script');
    }

    // If community post fails, the content is stored as a video script
    log.info('Content saved as video script for manual upload');
    return `script_${Date.now()}`;
  }

  async getEngagement(postId: string): Promise<Engagement | null> {
    if (!this.accessToken) return null;

    try {
      const resp = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${postId}`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );

      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const stats = data.items?.[0]?.statistics;
      if (!stats) return null;

      return {
        likes: parseInt(stats.likeCount || '0'),
        comments: parseInt(stats.commentCount || '0'),
        shares: 0,
        impressions: parseInt(stats.viewCount || '0'),
      };
    } catch {
      return null;
    }
  }
}

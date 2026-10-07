import type { PlatformClient, PostContent, Engagement } from './base.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

const log = getLogger('twitter');

export class TwitterClient implements PlatformClient {
  readonly platform = 'twitter';
  private config: HivemindConfig;
  private accessToken: string | null = null;
  private credentials: Record<string, string> = {};

  constructor(config: HivemindConfig) {
    this.config = config;
    const account = config.socialAccounts.find(a => a.platform === 'twitter');
    if (account?.credentials) {
      this.credentials = account.credentials;
      if (account.authMethod === 'api_key') {
        this.accessToken = account.credentials.accessToken || account.credentials.apiKey;
      }
    }
  }

  get isConfigured(): boolean {
    const account = this.config.socialAccounts.find(a => a.platform === 'twitter');
    return !!account?.enabled;
  }

  async authenticate(): Promise<void> {
    const account = this.config.socialAccounts.find(a => a.platform === 'twitter');
    if (!account?.credentials) throw new Error('Twitter not configured');

    if (account.authMethod === 'oauth') {
      await this.oauth2PKCEFlow(account.credentials);
    } else {
      this.accessToken = account.credentials.accessToken || account.credentials.apiKey;
    }
  }

  private async oauth2PKCEFlow(credentials: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const { clientId, clientSecret } = credentials;
      const redirectUri = 'http://localhost:9475/callback';
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('hex');

      const scopes = 'tweet.read tweet.write users.read offline.access';
      const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost:9475');
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code && url.searchParams.get('state') === state) {
            try {
              const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
              const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${authHeader}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: redirectUri,
                  code_verifier: codeVerifier,
                }),
              });
              const tokenData = await tokenResp.json() as any;
              this.accessToken = tokenData.access_token;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>Twitter connected! You can close this tab.</h1>');
              server.close();
              resolve();
            } catch (err) {
              res.writeHead(500);
              res.end('Error');
              server.close();
              reject(err);
            }
          }
        }
      });

      server.listen(9475, () => {
        log.info({ authUrl }, 'Open this URL to authenticate with Twitter');
      });

      setTimeout(() => { server.close(); reject(new Error('OAuth timeout')); }, 300000);
    });
  }

  async post(content: PostContent): Promise<string | null> {
    if (!this.accessToken) await this.authenticate();
    if (!this.accessToken) throw new Error('Not authenticated with Twitter');

    let text = content.content;
    if (content.hashtags?.length) {
      const tags = content.hashtags.map(h => `#${h}`).join(' ');
      if (text.length + tags.length + 2 <= 280) {
        text = `${text}\n\n${tags}`;
      }
    }

    // Truncate to 280 chars
    if (text.length > 280) {
      text = text.substring(0, 277) + '...';
    }

    const resp = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Twitter post failed: ${resp.status} ${error}`);
    }

    const data = await resp.json() as any;
    log.info({ tweetId: data.data?.id }, 'Posted to Twitter');
    return data.data?.id || null;
  }

  async getEngagement(postId: string): Promise<Engagement | null> {
    if (!this.accessToken) return null;

    try {
      const resp = await fetch(
        `https://api.twitter.com/2/tweets/${postId}?tweet.fields=public_metrics`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );

      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const metrics = data.data?.public_metrics;
      if (!metrics) return null;

      return {
        likes: metrics.like_count || 0,
        comments: metrics.reply_count || 0,
        shares: metrics.retweet_count || 0,
        impressions: metrics.impression_count || 0,
      };
    } catch {
      return null;
    }
  }
}

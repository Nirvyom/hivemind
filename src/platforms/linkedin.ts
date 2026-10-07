import type { PlatformClient, PostContent, Engagement } from './base.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import http from 'node:http';
import { URL } from 'node:url';

const log = getLogger('linkedin');

export class LinkedInClient implements PlatformClient {
  readonly platform = 'linkedin';
  private config: HivemindConfig;
  private accessToken: string | null = null;
  private personUrn: string | null = null;

  constructor(config: HivemindConfig) {
    this.config = config;
  }

  get isConfigured(): boolean {
    const account = this.config.socialAccounts.find(a => a.platform === 'linkedin');
    return !!account?.enabled;
  }

  async authenticate(): Promise<void> {
    const account = this.config.socialAccounts.find(a => a.platform === 'linkedin');
    if (!account?.credentials) throw new Error('LinkedIn not configured');

    if (account.authMethod === 'api_key') {
      this.accessToken = account.credentials.apiKey;
    } else {
      await this.oauthFlow(account.credentials);
    }

    // Get person URN
    if (this.accessToken) {
      try {
        const resp = await fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { 'Authorization': `Bearer ${this.accessToken}` },
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          this.personUrn = `urn:li:person:${data.sub}`;
        }
      } catch (err) {
        log.warn({ err }, 'Failed to get LinkedIn person URN');
      }
    }
  }

  private async oauthFlow(credentials: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const { clientId, clientSecret } = credentials;
      const redirectUri = 'http://localhost:9474/callback';
      const scopes = 'openid profile w_member_social';

      const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://localhost:9474`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code) {
            try {
              const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
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
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>LinkedIn connected! You can close this tab.</h1>');
              server.close();
              resolve();
            } catch (err) {
              res.writeHead(500);
              res.end('Error');
              server.close();
              reject(err);
            }
          } else {
            res.writeHead(400);
            res.end('No code received');
            server.close();
            reject(new Error('No OAuth code'));
          }
        }
      });

      server.listen(9474, () => {
        log.info('OAuth callback server listening on :9474');
        // In a real scenario, open the browser
        log.info({ authUrl }, 'Open this URL in your browser to authenticate');
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth timeout'));
      }, 300000);
    });
  }

  async post(content: PostContent): Promise<string | null> {
    if (!this.accessToken) await this.authenticate();
    if (!this.accessToken) throw new Error('Not authenticated');

    const postBody = content.hashtags?.length
      ? `${content.content}\n\n${content.hashtags.map(h => `#${h}`).join(' ')}`
      : content.content;

    const payload: any = {
      author: this.personUrn || 'urn:li:person:me',
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: postBody },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const resp = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`LinkedIn post failed: ${resp.status} ${error}`);
    }

    const data = await resp.json() as any;
    log.info({ postId: data.id }, 'Posted to LinkedIn');
    return data.id || null;
  }

  async getEngagement(postId: string): Promise<Engagement | null> {
    if (!this.accessToken) return null;

    try {
      const resp = await fetch(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );

      if (!resp.ok) return null;

      const data = await resp.json() as any;
      return {
        likes: data.likesSummary?.totalLikes || 0,
        comments: data.commentsSummary?.totalFirstLevelComments || 0,
        shares: 0,
        impressions: 0,
      };
    } catch {
      return null;
    }
  }
}

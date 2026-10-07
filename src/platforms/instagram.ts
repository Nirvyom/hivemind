import type { PlatformClient, PostContent, Engagement } from './base.js';
import type { HivemindConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

const log = getLogger('instagram');

export class InstagramClient implements PlatformClient {
  readonly platform = 'instagram';
  private config: HivemindConfig;
  private accessToken: string | null = null;
  private igUserId: string | null = null;

  constructor(config: HivemindConfig) {
    this.config = config;
  }

  get isConfigured(): boolean {
    const account = this.config.socialAccounts.find(a => a.platform === 'instagram');
    return !!account?.enabled;
  }

  async authenticate(): Promise<void> {
    const account = this.config.socialAccounts.find(a => a.platform === 'instagram');
    if (!account?.credentials) throw new Error('Instagram not configured');

    if (account.authMethod === 'api_key') {
      this.accessToken = account.credentials.apiKey;
      this.igUserId = account.credentials.igUserId;
    } else {
      await this.metaOAuthFlow(account.credentials);
    }
  }

  private async metaOAuthFlow(credentials: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const { clientId, clientSecret } = credentials;
      const redirectUri = 'http://localhost:9477/callback';
      const state = crypto.randomBytes(16).toString('hex');

      // Instagram Basic Display API / Graph API scopes
      const scopes = 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement';
      const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&response_type=code`;

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost:9477');
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code && url.searchParams.get('state') === state) {
            try {
              // Exchange code for access token
              const tokenResp = await fetch(
                `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`
              );
              const tokenData = await tokenResp.json() as any;
              this.accessToken = tokenData.access_token;

              // Get long-lived token
              const llTokenResp = await fetch(
                `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${this.accessToken}`
              );
              const llTokenData = await llTokenResp.json() as any;
              if (llTokenData.access_token) {
                this.accessToken = llTokenData.access_token;
              }

              // Get Instagram Business Account ID
              const pagesResp = await fetch(
                `https://graph.facebook.com/v19.0/me/accounts?access_token=${this.accessToken}`
              );
              const pagesData = await pagesResp.json() as any;
              const page = pagesData.data?.[0];

              if (page) {
                const igResp = await fetch(
                  `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${this.accessToken}`
                );
                const igData = await igResp.json() as any;
                this.igUserId = igData.instagram_business_account?.id;
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>Instagram connected! You can close this tab.</h1>');
              server.close();
              resolve();
            } catch (err) {
              server.close();
              reject(err);
            }
          }
        }
      });

      server.listen(9477, () => {
        log.info({ authUrl }, 'Open this URL to authenticate with Instagram');
        log.warn('Instagram requires Facebook Business account + Meta App Review');
      });

      setTimeout(() => { server.close(); reject(new Error('OAuth timeout')); }, 300000);
    });
  }

  async post(content: PostContent): Promise<string | null> {
    if (!this.accessToken) await this.authenticate();
    if (!this.accessToken || !this.igUserId) {
      throw new Error('Not authenticated with Instagram');
    }

    // Instagram Graph API requires a media URL for posting
    // Text-only posts aren't supported — need an image
    const caption = content.hashtags?.length
      ? `${content.content}\n\n${content.hashtags.map(h => `#${h}`).join(' ')}`
      : content.content;

    if (!content.mediaUrls?.length) {
      log.warn('Instagram requires an image/video URL. Saving as draft.');
      return null;
    }

    const mediaUrl = content.mediaUrls[0];

    // Step 1: Create media container
    const containerResp = await fetch(
      `https://graph.facebook.com/v19.0/${this.igUserId}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: mediaUrl,
          caption,
          access_token: this.accessToken,
        }),
      }
    );

    if (!containerResp.ok) {
      const error = await containerResp.text();
      throw new Error(`Instagram container creation failed: ${error}`);
    }

    const containerData = await containerResp.json() as any;
    const containerId = containerData.id;

    // Step 2: Publish media
    const publishResp = await fetch(
      `https://graph.facebook.com/v19.0/${this.igUserId}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: containerId,
          access_token: this.accessToken,
        }),
      }
    );

    if (!publishResp.ok) {
      const error = await publishResp.text();
      throw new Error(`Instagram publish failed: ${error}`);
    }

    const publishData = await publishResp.json() as any;
    log.info({ postId: publishData.id }, 'Posted to Instagram');
    return publishData.id || null;
  }

  async getEngagement(postId: string): Promise<Engagement | null> {
    if (!this.accessToken) return null;

    try {
      const resp = await fetch(
        `https://graph.facebook.com/v19.0/${postId}?fields=like_count,comments_count&access_token=${this.accessToken}`
      );

      if (!resp.ok) return null;
      const data = await resp.json() as any;

      return {
        likes: data.like_count || 0,
        comments: data.comments_count || 0,
        shares: 0,
        impressions: 0,
      };
    } catch {
      return null;
    }
  }
}

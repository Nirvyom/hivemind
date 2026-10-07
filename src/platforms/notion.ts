import type { PlatformClient, PostContent } from './base.js';
import type { HivemindConfig } from '../config/schema.js';

export interface NotionPage {
  id: string;
  url: string;
  title: string;
}

export class NotionClient implements PlatformClient {
  readonly platform = 'notion';
  private config: HivemindConfig;
  private apiKey: string;
  private baseUrl = 'https://api.notion.com/v1';
  private notionVersion = '2022-06-28';

  constructor(config: HivemindConfig) {
    this.config = config;
    this.apiKey = config.notion?.apiKey || '';
  }

  get isConfigured(): boolean {
    return !!this.config.notion?.apiKey;
  }

  async authenticate(): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('Notion API key not configured');
    }
    // Verify the key works by listing users
    const res = await this.request('/users', 'GET');
    if (!res.ok) {
      throw new Error(`Notion auth failed: ${res.status}`);
    }
  }

  async post(content: PostContent): Promise<string | null> {
    // Default: create a page in the first available database
    const databases = this.config.notion?.databases || {};
    const dbId = databases['content'] || databases['general'] || Object.values(databases)[0];
    if (!dbId) return null;

    const page = await this.createPage(dbId, content.title || 'Untitled', content.content);
    return page?.id || null;
  }

  async createPage(databaseId: string, title: string, body: string): Promise<NotionPage | null> {
    const res = await this.request('/pages', 'POST', {
      parent: { database_id: databaseId },
      properties: {
        Name: {
          title: [{ text: { content: title } }],
        },
      },
      children: this.markdownToBlocks(body),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Notion createPage failed: ${JSON.stringify(err)}`);
    }

    const data = await res.json();
    return { id: data.id, url: data.url, title };
  }

  async queryDatabase(databaseId: string, filter?: any): Promise<any[]> {
    const body: any = {};
    if (filter) body.filter = filter;

    const res = await this.request(`/databases/${databaseId}/query`, 'POST', body);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Notion queryDatabase failed: ${JSON.stringify(err)}`);
    }

    const data = await res.json();
    return data.results || [];
  }

  async updatePage(pageId: string, properties: Record<string, any>): Promise<void> {
    const res = await this.request(`/pages/${pageId}`, 'PATCH', { properties });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Notion updatePage failed: ${JSON.stringify(err)}`);
    }
  }

  private markdownToBlocks(markdown: string): any[] {
    // Simple markdown-to-Notion-blocks conversion
    return markdown.split('\n').filter(Boolean).map(line => {
      if (line.startsWith('# ')) {
        return {
          object: 'block',
          type: 'heading_1',
          heading_1: { rich_text: [{ text: { content: line.slice(2) } }] },
        };
      }
      if (line.startsWith('## ')) {
        return {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: line.slice(3) } }] },
        };
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        return {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] },
        };
      }
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: line } }] },
      };
    });
  }

  private async request(endpoint: string, method: string, body?: any): Promise<Response> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Notion-Version': this.notionVersion,
      'Content-Type': 'application/json',
    };

    return fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

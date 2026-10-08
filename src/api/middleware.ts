import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HivemindConfig } from '../config/schema.js';

export function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  config: HivemindConfig
): boolean {
  const authToken = config.api?.authToken;
  if (!authToken) return true; // No auth configured = open access

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${authToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

export function sendJson(res: ServerResponse, data: any, status: number = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function getUrlParams(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

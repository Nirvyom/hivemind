import { describe, it, expect } from 'vitest';
import { authenticate, parseBody, sendJson } from '../../src/api/middleware.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.headers = headers;
  req.destroy = () => {};
  return req;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
    },
    end(body?: string) {
      res._body = body || '';
    },
  } as any;
  return res;
}

describe('authenticate', () => {
  it('returns 503 when no auth token configured', () => {
    const req = mockReq();
    const res = mockRes();
    const config = { api: {} } as any;

    const result = authenticate(req, res, config);

    expect(result).toBe(false);
    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toEqual({ error: 'API authentication not configured' });
  });

  it('returns 401 for invalid token', () => {
    const req = mockReq({ authorization: 'Bearer wrong-token' });
    const res = mockRes();
    const config = { api: { authToken: 'secret-token' } } as any;

    const result = authenticate(req, res, config);

    expect(result).toBe(false);
    expect(res._status).toBe(401);
  });

  it('returns true for valid token', () => {
    const req = mockReq({ authorization: 'Bearer secret-token' });
    const res = mockRes();
    const config = { api: { authToken: 'secret-token' } } as any;

    const result = authenticate(req, res, config);

    expect(result).toBe(true);
  });
});

describe('parseBody', () => {
  it('rejects body exceeding 1MB', async () => {
    const req = mockReq();

    const promise = parseBody(req);

    // Send a chunk larger than 1MB
    const bigChunk = Buffer.alloc(1_048_577, 'a');
    (req as any).emit('data', bigChunk);

    await expect(promise).rejects.toThrow('Request body too large');
  });

  it('parses valid JSON body', async () => {
    const req = mockReq();

    const promise = parseBody(req);

    (req as any).emit('data', Buffer.from('{"key":"value"}'));
    (req as any).emit('end');

    const body = await promise;
    expect(body).toEqual({ key: 'value' });
  });

  it('returns empty object for empty body', async () => {
    const req = mockReq();

    const promise = parseBody(req);
    (req as any).emit('end');

    const body = await promise;
    expect(body).toEqual({});
  });
});

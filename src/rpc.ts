import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * JSON-RPC client, zero dependencies, on top of `node:http`.
 *
 * `fetch` would be shorter, but its keep-alive pool outlives `main()` and the
 * CLI calls `process.exit`, which on Windows can abort inside libuv while a
 * socket is still closing. One request per connection (`agent: false`) makes
 * the process exit deterministic, and every byte here is a viewing key or a
 * refund instruction, so connection reuse buys nothing worth the risk.
 *
 * Rules it enforces so callers cannot get them wrong:
 *  - only http(s). A `file:` or `data:` URL is refused before any request.
 *  - the timeout is per call, so a hung wallet cannot hang `settle` forever.
 *  - an error message names the method and the server's code, never the
 *    params: params contain memos, addresses, and amounts.
 */

export interface RpcPasswordAuth {
  user: string;
  password: string;
}

export interface RpcCookieAuth {
  /** Path to Zallet's `.cookie` file: one line, `user:password`. */
  cookieFile: string;
}

export type RpcAuth = RpcPasswordAuth | RpcCookieAuth;

export interface JsonRpcOptions {
  url: string;
  auth?: RpcAuth;
  /** Per-call timeout. Default 30s; callers that poll should raise it. */
  timeoutMs?: number;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed (${code}): ${message}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

function basicAuth(header: string): string {
  return `Basic ${Buffer.from(header, 'utf8').toString('base64')}`;
}

export class JsonRpcClient {
  private readonly url: URL;
  private readonly auth: RpcAuth | undefined;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: JsonRpcOptions) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new Error(`rpc: not a valid URL: ${opts.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`rpc: only http(s) URLs are supported, got ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error('rpc: put credentials in --rpc-user/--cookie-file, not in the URL');
    }
    this.url = parsed;
    this.auth = opts.auth;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** host:port only — safe to print, unlike the URL with embedded auth. */
  endpoint(): string {
    return this.url.host;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!this.auth) return headers;
    if ('cookieFile' in this.auth) {
      // Read per call: Zallet rotates the cookie when it restarts.
      let raw: string;
      try {
        raw = readFileSync(this.auth.cookieFile, 'utf8').trim();
      } catch {
        throw new Error(`rpc: cannot read cookie file ${this.auth.cookieFile}`);
      }
      const sep = raw.indexOf(':');
      if (sep < 1) throw new Error(`rpc: cookie file ${this.auth.cookieFile} is not user:password`);
      headers.authorization = basicAuth(raw);
    } else {
      headers.authorization = basicAuth(`${this.auth.user}:${this.auth.password}`);
    }
    return headers;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers = { ...this.headers(), 'content-length': String(Buffer.byteLength(body)) };

    const text = await new Promise<string>((resolve, reject) => {
      const send = this.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        this.url,
        { method: 'POST', headers, agent: false, timeout: this.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status === 401) {
              reject(new Error(`rpc: ${this.endpoint()} rejected the credentials (401)`));
              return;
            }
            if (status < 200 || status >= 300) {
              reject(new Error(`rpc: ${method} returned HTTP ${status}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', (err) => {
        reject(new Error(`rpc: ${method} could not reach ${this.endpoint()}: ${err.message}`));
      });
      req.end(body);
    });

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`rpc: ${method} returned a non-JSON body`);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new Error(`rpc: ${method} returned an unexpected body`);
    }
    const envelope = payload as {
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (envelope.error) {
      const code = typeof envelope.error.code === 'number' ? envelope.error.code : -32603;
      throw new RpcError(method, code, envelope.error.message ?? 'no message', envelope.error.data);
    }
    return envelope.result as T;
  }
}

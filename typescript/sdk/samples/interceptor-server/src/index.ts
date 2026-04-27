// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { withInterceptors } from '@ext-modelcontextprotocol/interceptors';
import { allInterceptors } from './interceptors.js';

const DEFAULT_PORT = 39817;
const DEFAULT_PATH = '/mcp';

interface ParsedArgs {
  port: number;
  path: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let port = DEFAULT_PORT;
  let path = DEFAULT_PATH;
  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      const p = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isNaN(p)) throw new Error(`invalid --port: ${arg}`);
      port = p;
    } else if (arg.startsWith('--path=')) {
      path = arg.slice('--path='.length);
    }
  }
  return { port, path };
}

function buildServer(): Server {
  const server = new Server(
    { name: 'interceptor-server-sample', version: '0.1.0' },
    { capabilities: {} },
  );
  withInterceptors(server, { interceptors: allInterceptors });
  return server;
}

/**
 * Stateless POST handler: build a fresh server + transport per request, run
 * the request to completion, then dispose. Mirrors the SDK's
 * `simpleStatelessStreamableHttp` example.
 */
async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const { port, path } = parseArgs(process.argv.slice(2));

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith(path)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Method not allowed.' },
        }),
      );
      return;
    }
    void handlePost(req, res).catch((err) => {
      process.stderr.write(`request error: ${err}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  process.stderr.write(
    `[interceptor-server-sample] listening on http://localhost:${port}${path}\n`,
  );

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Attribution Gateway — a fully self-contained twin of fallout-attribution-proxy.
 * A transparent McpInterceptorGateway proxies a BUNDLED fixture skill backend
 * (no external repo) and runs the SEP-2640 skill-attribution interceptor on
 * every `resources/read`. Reading a `skill://…/SKILL.md` produces a per-read
 * attribution audit tuple on stderr with the requester principal + traceId.
 *
 * Topology (all stdio, all in this repo):
 *   client ──▶ this proxy ──▶ fixture-backend.ts (skills)
 *                   └────────▶ skill-attribution host (interceptor)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpInterceptorGateway, InterceptionEvents } from '../../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const interceptorHostEntry = join(here, '../../skill-attribution/src/index.ts');
const backendEntry = join(here, 'fixture-backend.ts');

async function main(): Promise<void> {
  process.stderr.write('[attribution-gateway] starting interceptor host + fixture backend...\n');

  const interceptorClient = new Client(
    { name: 'skill-attribution-host', version: '1.0.0' },
    { capabilities: {} },
  );
  await interceptorClient.connect(
    new StdioClientTransport({ command: 'npx', args: ['tsx', interceptorHostEntry] }),
  );

  const backendClient = new Client(
    { name: 'fixture-skill-backend', version: '1.0.0' },
    { capabilities: {} },
  );
  await backendClient.connect(
    new StdioClientTransport({ command: 'npx', args: ['tsx', backendEntry] }),
  );

  const gateway = new McpInterceptorGateway({
    backendClient,
    interceptorClients: [interceptorClient],
    events: [InterceptionEvents.ResourcesRead],
    defaultContext: {
      principal: { type: 'user', id: 'demo-user@example.com' },
      traceId: 'trace-attribution-demo',
    },
  });

  const server = new Server(
    { name: 'attribution-gateway', version: '0.1.0' },
    { capabilities: {} },
  );
  gateway.configureServer(server);
  gateway.registerNotificationForwarding(server);

  await server.connect(new StdioServerTransport());
  process.stderr.write('[attribution-gateway] ready (proxying fixture backend, auditing resources/read)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

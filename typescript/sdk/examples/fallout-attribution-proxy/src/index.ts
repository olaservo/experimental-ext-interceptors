#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Fallout Attribution Proxy — a transparent stdio MCP server that looks exactly
 * like the `fallout-helper` backend but runs the SEP-2640 skill-attribution
 * interceptor on every `resources/read`. Reading a `skill://…/SKILL.md` resource
 * through this proxy produces a per-read attribution audit tuple (on stderr)
 * carrying the requester principal + traceId supplied as the gateway's
 * defaultContext.
 *
 * Topology (all stdio):
 *   client ──▶ this proxy ──▶ fallout-helper (backend)
 *                   └────────▶ skill-attribution host (interceptor)
 *
 * Modeled on Bob's examples/transparent-proxy.
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

// The prebuilt fallout-helper bundle. SKILLS_DIR resolves relative to the
// bundle's own location, so cwd doesn't matter. Override with FALLOUT_HELPER_DIST.
const FALLOUT_HELPER_DIST =
  process.env.FALLOUT_HELPER_DIST ??
  'C:\\Users\\johnn\\OneDrive\\Documents\\GitHub\\skills-over-mcp-ig\\bellagio\\agent-skills-ttrpg-demo\\mcp\\fallout-helper\\dist\\index.js';

async function main(): Promise<void> {
  process.stderr.write('[fallout-proxy] starting interceptor host + backend...\n');

  const interceptorClient = new Client(
    { name: 'skill-attribution-host', version: '1.0.0' },
    { capabilities: {} },
  );
  await interceptorClient.connect(
    new StdioClientTransport({ command: 'npx', args: ['tsx', interceptorHostEntry] }),
  );

  const backendClient = new Client(
    { name: 'fallout-helper-backend', version: '1.0.0' },
    { capabilities: {} },
  );
  await backendClient.connect(
    new StdioClientTransport({ command: 'node', args: [FALLOUT_HELPER_DIST, '--stdio'] }),
  );

  const gateway = new McpInterceptorGateway({
    backendClient,
    interceptorClients: [interceptorClient],
    events: [InterceptionEvents.ResourcesRead],
    // Requester identity the audit tuple records (the gateway forwards this as
    // the invoke context; a real deployment would derive it per-session).
    defaultContext: {
      principal: { type: 'user', id: 'gm@example.com' },
      traceId: 'trace-fallout-session',
    },
  });

  const server = new Server(
    { name: 'fallout-attribution-proxy', version: '0.1.0' },
    { capabilities: {} },
  );
  gateway.configureServer(server);
  gateway.registerNotificationForwarding(server);

  await server.connect(new StdioServerTransport());
  process.stderr.write('[fallout-proxy] ready (proxying fallout-helper, auditing resources/read)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

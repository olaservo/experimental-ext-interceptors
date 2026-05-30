#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Attribution Gateway Demo — spawns the self-contained attribution gateway
 * (which in turn spawns the bundled fixture backend + the skill-attribution
 * host), then lists and reads every `skill://…/SKILL.md` THROUGH the proxy.
 * Each read triggers the attribution interceptor; watch stderr for the
 * `[skill-attribution] {…}` audit tuples (compliance level + requester + traceId).
 *
 * Fully self-contained: no external repo or prebuilt backend required.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const proxyEntry = join(here, 'index.ts');

console.log('=== Attribution Gateway Demo (self-contained) ===\n');
console.log('[setup] Spawning gateway (→ fixture backend + attribution host)...');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', proxyEntry],
});

const client = new Client(
  { name: 'attribution-gateway-demo', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
console.log('[setup] Connected to gateway.\n');

const { resources } = await client.listResources();
const skillManifests = resources.filter((r) => r.uri.endsWith('/SKILL.md'));

console.log(`Found ${skillManifests.length} SKILL.md resource(s):`);
for (const r of skillManifests) console.log(`  - ${r.uri}`);
console.log('');

for (const r of skillManifests) {
  console.log(`── reading ${r.uri} ──`);
  const result = await client.readResource({ uri: r.uri });
  const first = result.contents?.[0];
  const text = first && 'text' in first ? first.text : undefined;
  const bytes = typeof text === 'string' ? text.length : 0;
  console.log(`  read ok (${bytes} bytes) — attribution audited; see [skill-attribution] line on stderr`);
  console.log('');
}

console.log('=== Done — audit tuples above came from the bundled fixture skills ===');
await client.close();

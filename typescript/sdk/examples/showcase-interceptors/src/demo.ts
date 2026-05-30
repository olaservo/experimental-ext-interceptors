#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Showcase Demo — spawns the showcase host and runs interceptor chains for
 * tools/call and resources/read across request + response phases, showing
 * validation pass/block, mutation (lowercasing, redaction), and sink logging.
 * Mirrors Bob's interceptor-client example.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  executeInterceptorChainOnClient,
  InterceptionEvents,
} from '../../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(here, 'index.ts');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', hostEntry],
  cwd: join(here, '..'),
});

const client = new Client(
  { name: 'showcase-demo', version: '1.0.0' },
  { capabilities: {} },
);

console.log('=== Showcase Interceptors Demo ===\n');
console.log('[setup] Spawning showcase host...');
await client.connect(transport);
console.log('[setup] Connected.\n');

interface Case {
  label: string;
  event: string;
  phase: 'request' | 'response';
  payload: unknown;
}

const cases: Case[] = [
  {
    label: 'tools/call clean (lowercased, passes)',
    event: InterceptionEvents.ToolsCall,
    phase: 'request',
    payload: { name: 'echo', arguments: { message: 'Hello WASTELAND' } },
  },
  {
    label: 'tools/call with SSN (blocked)',
    event: InterceptionEvents.ToolsCall,
    phase: 'request',
    payload: { name: 'echo', arguments: { message: 'My SSN is 123-45-6789' } },
  },
  {
    label: 'tools/call with email (blocked)',
    event: InterceptionEvents.ToolsCall,
    phase: 'request',
    payload: { name: 'echo', arguments: { message: 'Contact alice@example.com' } },
  },
  {
    label: 'resources/read of file:///etc/passwd (blocked)',
    event: InterceptionEvents.ResourcesRead,
    phase: 'request',
    payload: { uri: 'file:///etc/passwd' },
  },
  {
    label: 'resources/read response containing an API key (redacted)',
    event: InterceptionEvents.ResourcesRead,
    phase: 'response',
    payload: {
      contents: [
        {
          uri: 'file:///app/config.txt',
          mimeType: 'text/plain',
          text: 'api_key=sk-live-ABCDEFGH12345678 # do not leak',
        },
      ],
    },
  },
];

for (const c of cases) {
  console.log(`── ${c.label} ──`);
  const chain = await executeInterceptorChainOnClient(client, {
    event: c.event,
    phase: c.phase,
    payload: c.payload,
    context: { traceId: 'trace-showcase' },
  });
  console.log(`  status:   ${chain.status}`);
  console.log(`  ran:      ${chain.results.length} interceptor(s)`);
  if (chain.abortedAt) {
    console.log(`  aborted:  ${chain.abortedAt.interceptor} — ${chain.abortedAt.reason}`);
  }
  if (chain.finalPayload !== undefined) {
    console.log(`  payload:  ${JSON.stringify(chain.finalPayload)}`);
  }
  console.log('');
}

console.log('=== Done (see [interceptor] sink lines on stderr above) ===');
await client.close();

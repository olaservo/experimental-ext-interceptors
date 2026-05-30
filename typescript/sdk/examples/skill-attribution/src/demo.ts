#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Skill Attribution Demo — spawns the attribution host and replays a few
 * `resources/read` *responses* through it (response phase), passing requester
 * context (principal + traceId) so the per-read audit tuple is populated.
 *
 * Mirrors Bob's interceptor-client example. The host emits one
 * `[skill-attribution] {…}` JSON line to stderr per skill read; this driver
 * prints the validation verdict (valid / severity / messages / complianceLevel).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  InterceptionEvents,
  invokeInterceptor,
  isValidationResult,
} from '../../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(here, 'index.ts');

// --- SKILL.md fixtures (frontmatter under `metadata` per the Agent Skills spec) ---

const COMPLIANT_SKILL = `---
name: fallout-rpg
description: Helper for running the Fallout tabletop RPG.
license: CC-BY-4.0
metadata:
  skill_author: Ola Hungerford
  source: https://github.com/olaservo/fallout-helper
  version: 1.0.0
  citations:
    - https://fallout.fandom.com/wiki/Fallout_(tabletop_game)
  sources:
    - name: Fallout — The Roleplaying Game (Modiphius)
      url: https://www.modiphius.net/products/fallout-the-roleplaying-game
---
# Fallout RPG helper
Body content...
`;

const PARTIAL_SKILL = `---
name: wasteland-survival
description: Tips for surviving the wasteland.
metadata:
  skill_author: A Wasteland GM
---
# Wasteland survival
Body content...
`;

interface Case {
  label: string;
  uri: string;
  text?: string;
  principalId: string;
  traceId: string;
}

const cases: Case[] = [
  {
    label: 'compliant skill (author + license + source + sources[])',
    uri: 'skill://olaservo/fallout-helper/fallout-rpg/SKILL.md',
    text: COMPLIANT_SKILL,
    principalId: 'gm@example.com',
    traceId: 'trace-falloutRpg',
  },
  {
    label: 'partial skill (author only)',
    uri: 'skill://acme/survival/wasteland-survival/SKILL.md',
    text: PARTIAL_SKILL,
    principalId: 'player@example.com',
    traceId: 'trace-wasteland',
  },
  {
    label: 'non-skill resource (passes silently)',
    uri: 'file:///tmp/session-notes.txt',
    text: 'Just some plain notes, not a SKILL.md.',
    principalId: 'gm@example.com',
    traceId: 'trace-notes',
  },
];

console.log('=== Skill Attribution Demo ===\n');
console.log('[setup] Spawning attribution host...');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', hostEntry],
  cwd: join(here, '..'),
});

const client = new Client(
  { name: 'skill-attribution-demo', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
console.log('[setup] Connected.\n');

for (const c of cases) {
  console.log(`── ${c.label} ──`);
  const payload = {
    contents: [{ uri: c.uri, mimeType: 'text/markdown', text: c.text }],
  };
  const result = await invokeInterceptor(client, {
    name: 'skill-attribution-validator',
    event: InterceptionEvents.ResourcesRead,
    phase: 'response',
    payload,
    context: {
      principal: { type: 'user', id: c.principalId },
      traceId: c.traceId,
    },
  });
  if (isValidationResult(result)) {
    console.log(`  valid:    ${result.valid}`);
    console.log(`  severity: ${result.severity ?? '(none)'}`);
    const compliance = (result.info as { complianceLevel?: string } | undefined)
      ?.complianceLevel;
    if (compliance) console.log(`  compliance: ${compliance}`);
    for (const msg of result.messages ?? []) {
      console.log(`  [${msg.severity}] ${msg.path ?? ''} ${msg.message}`);
    }
  }
  console.log('');
}

console.log('=== Done (see [skill-attribution] audit lines on stderr above) ===');
await client.close();

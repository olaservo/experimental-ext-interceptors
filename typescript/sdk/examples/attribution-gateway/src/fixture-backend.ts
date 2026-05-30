#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Fixture skill backend — a tiny self-contained stdio MCP server that serves a
 * few `skill://…/SKILL.md` resources from inline fixtures. Stands in for a real
 * skills server (like fallout-helper) so the attribution-gateway example runs
 * anywhere with no external repo or build. Three skills exercise each grade:
 * compliant (layered attribution), partial (author only), and uncredited.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const COMPLIANT_SKILL = `---
name: weather-reporter
description: Look up and summarize current weather for a location.
license: Apache-2.0
metadata:
  skill_author:
    name: Jane Dev
    url: https://github.com/janedev
  version: 1.2.0
  sources:
    - title: OpenWeather API documentation
      publisher: OpenWeather
      url: https://openweathermap.org/api
      rights_basis: license_grant
      covers: weather field semantics and units
  attribution: |
    Authored by Jane Dev (Apache-2.0). Weather field semantics derived from the
    OpenWeather API documentation under their developer terms.
---
# Weather Reporter
Body content...
`;

const PARTIAL_SKILL = `---
name: note-taker
description: Capture and organize freeform notes.
metadata:
  skill_author: Sam Maker
---
# Note Taker
Body content...
`;

const UNCREDITED_SKILL = `---
name: mystery-tool
description: Does something useful; provenance unclear.
---
# Mystery Tool
Body content...
`;

interface SkillFixture {
  name: string;
  description: string;
  text: string;
}

const SKILLS: Record<string, SkillFixture> = {
  'skill://demo/weather-reporter/SKILL.md': {
    name: 'weather-reporter',
    description: 'Weather lookup skill (fully attributed).',
    text: COMPLIANT_SKILL,
  },
  'skill://demo/note-taker/SKILL.md': {
    name: 'note-taker',
    description: 'Note-taking skill (author only).',
    text: PARTIAL_SKILL,
  },
  'skill://demo/mystery-tool/SKILL.md': {
    name: 'mystery-tool',
    description: 'Unattributed skill.',
    text: UNCREDITED_SKILL,
  },
};

const server = new Server(
  { name: 'fixture-skill-backend', version: '1.0.0' },
  { capabilities: { resources: {} } },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: Object.entries(SKILLS).map(([uri, s]) => ({
    uri,
    name: s.name,
    description: s.description,
    mimeType: 'text/markdown',
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  const skill = SKILLS[uri];
  if (!skill) throw new Error(`Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: 'text/markdown', text: skill.text }] };
});

await server.connect(new StdioServerTransport());

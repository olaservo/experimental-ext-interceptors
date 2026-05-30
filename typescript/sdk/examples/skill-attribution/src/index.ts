#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Skill Attribution Host — stdio MCP interceptor host exposing the SEP-2640
 * attribution validator. Spawned by demo.ts (or any MCP client using
 * StdioClientTransport). Ported from the fork's skill-attribution-gateway,
 * which used `withInterceptors` on an HTTP server; under Bob's SDK it is a
 * host registered via `registerInterceptorsOnServer`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerInterceptorsOnServer } from '../../../dist/index.js';
import { skillAttributionValidator } from './interceptors.js';

const server = new Server(
  { name: 'skill-attribution-host', version: '0.1.0' },
  { capabilities: {} },
);

registerInterceptorsOnServer(server, [skillAttributionValidator]);

const transport = new StdioServerTransport();
await server.connect(transport);

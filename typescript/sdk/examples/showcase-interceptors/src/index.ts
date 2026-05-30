#!/usr/bin/env node
// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
/**
 * Showcase Interceptors Host — stdio MCP interceptor host exposing the six
 * validation/mutation/sink interceptors ported from the fork's
 * `interceptor-server` sample. Spawned by demo.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerInterceptorsOnServer } from '../../../dist/index.js';
import { allInterceptors } from './interceptors.js';

const server = new Server(
  { name: 'showcase-interceptors-host', version: '0.1.0' },
  { capabilities: {} },
);

registerInterceptorsOnServer(server, allInterceptors);

const transport = new StdioServerTransport();
await server.connect(transport);

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InterceptorEvents,
  McpInterceptorValidationError,
  ValidationResult,
} from '../protocol/index.js';
import { defineInterceptor } from '../server/defineInterceptor.js';
import { withInterceptors } from '../server/withInterceptors.js';
import { InterceptingClient } from './interceptingClient.js';

interface Harness {
  intercepting: InterceptingClient;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  resourceReads: string[];
  teardown: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const toolCalls: Harness['toolCalls'] = [];
  const resourceReads: string[] = [];

  // ---- backend MCP server ----
  const backendServer = new Server(
    { name: 'backend', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  backendServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'echo',
        description: 'echo back arguments',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  backendServer.setRequestHandler(CallToolRequestSchema, (req) => {
    toolCalls.push({
      name: req.params.name,
      args: (req.params.arguments ?? {}),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(req.params.arguments ?? {}),
        },
      ],
    };
  });
  backendServer.setRequestHandler(ReadResourceRequestSchema, (req) => {
    resourceReads.push(req.params.uri);
    return {
      contents: [
        {
          uri: req.params.uri,
          mimeType: 'text/plain',
          text: 'API_KEY=sk-live-abcd1234',
        },
      ],
    };
  });

  // ---- interceptor server ----
  const interceptorServer = new Server(
    { name: 'interceptors', version: '0.0.0' },
    { capabilities: {} },
  );
  withInterceptors(interceptorServer, {
    interceptors: [
      defineInterceptor({
        name: 'lower-args',
        events: [InterceptorEvents.ToolsCall],
        type: 'mutation',
        phase: 'request',
        priorityHint: 0,
        invoke: ({ payload }) => {
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('arguments' in payload)
          ) {
            return { type: 'mutation', modified: false };
          }
          const p = payload as {
            name: string;
            arguments?: Record<string, unknown>;
          };
          if (!p.arguments) {
            return { type: 'mutation', modified: false };
          }
          const next: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p.arguments)) {
            next[k] = typeof v === 'string' ? v.toLowerCase() : v;
          }
          return {
            type: 'mutation',
            modified: true,
            payload: { ...p, arguments: next },
          };
        },
      }),
      defineInterceptor({
        // Looks for the lowercase form because the `lower-args` mutation runs
        // first in the request phase (mutations → validations per SEP-1763).
        name: 'no-secrets',
        events: [InterceptorEvents.ToolsCall],
        type: 'validation',
        phase: 'request',
        invoke: ({ payload }) => {
          if (JSON.stringify(payload).includes('forbidden')) {
            return ValidationResult.error('contains forbidden token');
          }
          return ValidationResult.success();
        },
      }),
      defineInterceptor({
        name: 'redact-secrets',
        events: [InterceptorEvents.ResourcesRead],
        type: 'mutation',
        phase: 'response',
        invoke: ({ payload }) => {
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('contents' in payload)
          ) {
            return { type: 'mutation', modified: false };
          }
          const contents = (
            payload as { contents?: Array<{ text?: string }> }
          ).contents;
          if (!Array.isArray(contents)) {
            return { type: 'mutation', modified: false };
          }
          const next = contents.map((c) =>
            typeof c.text === 'string'
              ? {
                  ...c,
                  text: c.text.replace(
                    /sk-live-[A-Za-z0-9]+/g,
                    '[REDACTED]',
                  ),
                }
              : c,
          );
          return {
            type: 'mutation',
            modified: true,
            payload: { ...(payload as object), contents: next },
          };
        },
      }),
      defineInterceptor({
        name: 'deny-etc',
        events: [InterceptorEvents.ResourcesRead],
        type: 'validation',
        phase: 'request',
        invoke: ({ payload }) => {
          const uri =
            payload && typeof payload === 'object' && 'uri' in payload
              ? String((payload as { uri: unknown }).uri)
              : '';
          if (uri.startsWith('file:///etc/')) {
            return ValidationResult.error(`denied: ${uri}`);
          }
          return ValidationResult.success();
        },
      }),
    ],
  });

  // ---- transports + clients ----
  const [backendServerT, backendClientT] = InMemoryTransport.createLinkedPair();
  const [interceptorServerT, interceptorClientT] =
    InMemoryTransport.createLinkedPair();

  const backendClient = new Client(
    { name: 'backend-c', version: '0.0.0' },
    { capabilities: {} },
  );
  const interceptorClient = new Client(
    { name: 'interceptor-c', version: '0.0.0' },
    { capabilities: {} },
  );

  await Promise.all([
    backendServer.connect(backendServerT),
    backendClient.connect(backendClientT),
    interceptorServer.connect(interceptorServerT),
    interceptorClient.connect(interceptorClientT),
  ]);

  const intercepting = new InterceptingClient(backendClient, {
    interceptorClient,
    events: [InterceptorEvents.ToolsCall, InterceptorEvents.ResourcesRead],
  });

  return {
    intercepting,
    toolCalls,
    resourceReads,
    teardown: async () => {
      await backendClient.close();
      await interceptorClient.close();
      await backendServer.close();
      await interceptorServer.close();
    },
  };
}

describe('InterceptingClient — end-to-end', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('mutates tool call arguments before they reach the backend', async () => {
    await h.intercepting.callTool({
      name: 'echo',
      arguments: { who: 'WORLD' },
    });
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0].args.who).toBe('world'); // lowercased
  });

  it('throws McpInterceptorValidationError when a request validator aborts', async () => {
    // The lowercaser runs first and turns "FORBIDDEN" into "forbidden", which
    // the validator then catches — proving mutations execute before validations.
    await expect(
      h.intercepting.callTool({
        name: 'echo',
        arguments: { token: 'FORBIDDEN' },
      }),
    ).rejects.toBeInstanceOf(McpInterceptorValidationError);
    expect(h.toolCalls).toHaveLength(0); // backend never reached
  });

  it('blocks reads of deny-listed URIs', async () => {
    await expect(
      h.intercepting.readResource({ uri: 'file:///etc/passwd' }),
    ).rejects.toBeInstanceOf(McpInterceptorValidationError);
    expect(h.resourceReads).toHaveLength(0);
  });

  it('redacts secrets from resource read responses', async () => {
    const result = await h.intercepting.readResource({
      uri: 'memory://config',
    });
    expect(h.resourceReads).toEqual(['memory://config']);
    expect(result.contents).toHaveLength(1);
    expect((result.contents[0] as { text: string }).text).toContain(
      '[REDACTED]',
    );
    expect((result.contents[0] as { text: string }).text).not.toContain(
      'sk-live',
    );
  });
});

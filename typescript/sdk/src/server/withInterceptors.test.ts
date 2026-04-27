// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { describe, expect, it } from 'vitest';
import {
  executeRemoteChain,
  invokeInterceptor,
  listInterceptors,
} from '../client/interceptorClientHelpers.js';
import {
  InterceptorEvents,
  MutationResult,
  ValidationResult,
} from '../protocol/index.js';
import { defineInterceptor } from './defineInterceptor.js';
import { withInterceptors } from './withInterceptors.js';

async function spinUpInterceptorServer() {
  const server = new Server(
    { name: 'test-interceptor-server', version: '0.0.0' },
    { capabilities: {} },
  );

  const echoer = defineInterceptor({
    name: 'echo-validator',
    type: 'validation',
    events: [InterceptorEvents.ToolsCall],
    phase: 'request',
    invoke: () => ValidationResult.success(),
  });
  const blocker = defineInterceptor({
    name: 'blocker',
    type: 'validation',
    events: [InterceptorEvents.ResourcesRead],
    phase: 'request',
    invoke: ({ payload }) => {
      const uri =
        payload && typeof payload === 'object' && 'uri' in payload
          ? String((payload as { uri: unknown }).uri)
          : '';
      if (uri.startsWith('file:///etc/')) {
        return ValidationResult.error(`denied: ${uri}`, '$.uri');
      }
      return ValidationResult.success();
    },
  });
  const upper = defineInterceptor({
    name: 'upper-mutator',
    type: 'mutation',
    events: [InterceptorEvents.ResourcesRead],
    phase: 'response',
    invoke: ({ payload }) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('contents' in payload)
      ) {
        return MutationResult.unchanged(payload);
      }
      const contents = (payload as { contents?: Array<{ text?: string }> })
        .contents;
      if (!Array.isArray(contents)) return MutationResult.unchanged(payload);
      const next = contents.map((c) =>
        typeof c.text === 'string' ? { ...c, text: c.text.toUpperCase() } : c,
      );
      return MutationResult.mutated({ ...(payload as object), contents: next });
    },
  });

  withInterceptors(server, { interceptors: [echoer, blocker, upper] });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('withInterceptors — end-to-end via in-memory transport', () => {
  it('lists hosted interceptors', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const list = await listInterceptors(client);
      expect(list.interceptors.map((i) => i.name).sort()).toEqual([
        'blocker',
        'echo-validator',
        'upper-mutator',
      ]);
      // Each interceptor returns its hooks array (SEP-2624 shape).
      const echo = list.interceptors.find((i) => i.name === 'echo-validator')!;
      expect(echo.hooks).toEqual([
        { events: [InterceptorEvents.ToolsCall], phase: 'request' },
      ]);
    } finally {
      await teardown();
    }
  });

  it('lists interceptors filtered by event', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const list = await listInterceptors(client, {
        event: InterceptorEvents.ResourcesRead,
      });
      expect(list.interceptors.map((i) => i.name).sort()).toEqual([
        'blocker',
        'upper-mutator',
      ]);
    } finally {
      await teardown();
    }
  });

  it('invokes a single interceptor and returns the discriminated result', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const result = await invokeInterceptor(client, {
        name: 'blocker',
        event: InterceptorEvents.ResourcesRead,
        phase: 'request',
        payload: { uri: 'file:///etc/passwd' },
      });
      expect(result.type).toBe('validation');
      if (result.type !== 'validation') return;
      expect(result.valid).toBe(false);
      expect(result.severity).toBe('error');
      expect(result.interceptor).toBe('blocker');
    } finally {
      await teardown();
    }
  });

  it('SDK-side chain (executeRemoteChain) aborts on validation error', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const chain = await executeRemoteChain([client], {
        event: InterceptorEvents.ResourcesRead,
        phase: 'request',
        payload: { uri: 'file:///etc/passwd' },
      });
      expect(chain.status).toBe('validation_failed');
      expect(chain.abortedAt?.interceptor).toBe('blocker');
      expect(chain.event).toBe(InterceptorEvents.ResourcesRead);
    } finally {
      await teardown();
    }
  });

  it('SDK-side chain mutates a response payload via interceptor/invoke', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const chain = await executeRemoteChain([client], {
        event: InterceptorEvents.ResourcesRead,
        phase: 'response',
        payload: {
          contents: [{ uri: 'memory://x', mimeType: 'text/plain', text: 'hi' }],
        },
      });
      expect(chain.status).toBe('success');
      const final = chain.finalPayload as {
        contents: Array<{ text: string }>;
      };
      expect(final.contents[0].text).toBe('HI');
    } finally {
      await teardown();
    }
  });

  it('advertises capabilities.experimental.interceptor (singular per SEP)', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const caps = client.getServerCapabilities();
      expect(caps?.experimental).toBeDefined();
      const ext = caps?.experimental as
        | { interceptor?: { supportedEvents?: string[] } }
        | undefined;
      expect(ext?.interceptor?.supportedEvents).toEqual(
        expect.arrayContaining([
          InterceptorEvents.ToolsCall,
          InterceptorEvents.ResourcesRead,
        ]),
      );
    } finally {
      await teardown();
    }
  });
});

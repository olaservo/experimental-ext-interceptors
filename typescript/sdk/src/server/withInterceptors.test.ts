// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { describe, expect, it } from 'vitest';
import {
  executeInterceptorChain,
  invokeInterceptor,
  listInterceptors,
} from '../client/interceptorClientHelpers.js';
import {
  InterceptorEvents,
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
    events: [InterceptorEvents.ToolsCall],
    type: 'validation',
    phase: 'request',
    invoke: () => ValidationResult.success(),
  });
  const blocker = defineInterceptor({
    name: 'blocker',
    events: [InterceptorEvents.ResourcesRead],
    type: 'validation',
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
      const contents = (payload as { contents?: Array<{ text?: string }> })
        .contents;
      if (!Array.isArray(contents)) {
        return { type: 'mutation', modified: false };
      }
      const next = contents.map((c) =>
        typeof c.text === 'string' ? { ...c, text: c.text.toUpperCase() } : c,
      );
      return {
        type: 'mutation',
        modified: true,
        payload: { ...(payload as object), contents: next },
      };
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

  it('executes a chain that aborts on validation error', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const chain = await executeInterceptorChain(client, {
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

  it('executes a chain that mutates a response payload', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const chain = await executeInterceptorChain(client, {
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

  it('advertises the interceptors capability in experimental.', async () => {
    const { client, teardown } = await spinUpInterceptorServer();
    try {
      const caps = client.getServerCapabilities();
      expect(caps?.experimental).toBeDefined();
      const ext = caps?.experimental as
        | { interceptors?: { supportedEvents?: string[] } }
        | undefined;
      expect(ext?.interceptors?.supportedEvents).toEqual(
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

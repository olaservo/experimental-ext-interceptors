// Smoke test: spin up the sample interceptor server over stdio, then exercise
// listInterceptors, executeInterceptorChain (request and response phases for
// resources/read), and the InterceptingClient deny-list and redaction flows.
//
//   node smoke-test.mjs
//
// Exits 0 on success, 1 on any failed assertion.

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  executeInterceptorChain,
  listInterceptors,
  InterceptingClient,
  McpInterceptorValidationError,
} from '@ext-modelcontextprotocol/interceptors';

// ---------------------------------------------------------------------------
// 1. Spawn the sample over stdio and connect a Client.
// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'),
});
const client = new Client(
  { name: 'smoke-test', version: '0.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

// listInterceptors
const list = await listInterceptors(client);
console.log('interceptors:', list.interceptors.map((i) => i.name).join(', '));
assert.equal(list.interceptors.length, 6, 'expected 6 interceptors');

// resources/read request phase: deny-listed URI is blocked.
const blocked = await executeInterceptorChain(client, {
  event: 'resources/read',
  phase: 'request',
  payload: { uri: 'file:///etc/passwd' },
});
console.log(
  'deny-list block status=%s aborted-at=%s',
  blocked.status,
  blocked.abortedAt?.interceptor,
);
assert.equal(blocked.status, 'validation_failed');
assert.equal(blocked.abortedAt?.interceptor, 'resource-uri-guard');

// resources/read request phase: safe URI passes.
const ok = await executeInterceptorChain(client, {
  event: 'resources/read',
  phase: 'request',
  payload: { uri: 'memory://config' },
});
console.log('safe-uri status=%s', ok.status);
assert.equal(ok.status, 'success');

// resources/read response phase: secret in content is redacted.
const redacted = await executeInterceptorChain(client, {
  event: 'resources/read',
  phase: 'response',
  payload: {
    contents: [
      {
        uri: 'memory://config',
        mimeType: 'text/plain',
        text: 'API_KEY=sk-live-abcd1234',
      },
    ],
  },
});
console.log('redaction status=%s', redacted.status);
assert.equal(redacted.status, 'success');
const redactedText = redacted.finalPayload?.contents?.[0]?.text ?? '';
assert.match(
  redactedText,
  /\[REDACTED\]/,
  'expected response payload to be redacted',
);
assert.doesNotMatch(redactedText, /sk-live/);

// ---------------------------------------------------------------------------
// 2. Wrapped-client demo with an in-process backend.
// ---------------------------------------------------------------------------

const backendServer = new Server(
  { name: 'mock-backend', version: '0.0.0' },
  { capabilities: { resources: {} } },
);
backendServer.setRequestHandler(ReadResourceRequestSchema, (req) => ({
  contents: [
    {
      uri: req.params.uri,
      mimeType: 'text/plain',
      text: 'API_KEY=sk-live-deadbeef',
    },
  ],
}));

const [backendServerT, backendClientT] = InMemoryTransport.createLinkedPair();
const backendClient = new Client(
  { name: 'backend-c', version: '0.0.0' },
  { capabilities: {} },
);
await Promise.all([
  backendServer.connect(backendServerT),
  backendClient.connect(backendClientT),
]);

const intercepting = new InterceptingClient(backendClient, {
  interceptorClient: client,
  events: ['resources/read'],
});

let threw = false;
try {
  await intercepting.readResource({ uri: 'file:///etc/passwd' });
} catch (err) {
  threw = err instanceof McpInterceptorValidationError;
  console.log('wrapped deny-list threw McpInterceptorValidationError:', threw);
}
assert.ok(threw, 'expected McpInterceptorValidationError');

const safe = await intercepting.readResource({ uri: 'memory://config' });
const safeText = safe.contents[0].text ?? '';
console.log('wrapped redaction text=%s', safeText);
assert.match(safeText, /\[REDACTED\]/);
assert.doesNotMatch(safeText, /sk-live/);

await backendClient.close();
await backendServer.close();
await client.close();
console.log('smoke-test OK');
process.exit(0);

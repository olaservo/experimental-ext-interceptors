// Smoke test over Streamable HTTP. Assumes the sample is already listening:
//   node dist/index.js &
//   node smoke-test.mjs                          # default http://localhost:39817/mcp
//   node smoke-test.mjs http://host:port/path    # custom URL
//
// Exits 0 on success, non-zero on any failed assertion.

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  executeRemoteChain,
  listInterceptors,
  InterceptingClient,
  McpInterceptorValidationError,
} from '@ext-modelcontextprotocol/interceptors';

const url = new URL(process.argv[2] ?? 'http://localhost:39817/mcp');

const transport = new StreamableHTTPClientTransport(url);
const client = new Client(
  { name: 'http-smoke-test', version: '0.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

const list = await listInterceptors(client);
console.log('http listInterceptors:', list.interceptors.map((i) => i.name).join(', '));
assert.equal(list.interceptors.length, 6);

const blocked = await executeRemoteChain([client], {
  event: 'resources/read',
  phase: 'request',
  payload: { uri: 'file:///etc/passwd' },
});
console.log('http deny status=%s aborted-at=%s', blocked.status, blocked.abortedAt?.interceptor);
assert.equal(blocked.status, 'validation_failed');
assert.equal(blocked.abortedAt?.interceptor, 'resource-uri-guard');

const redacted = await executeRemoteChain([client], {
  event: 'resources/read',
  phase: 'response',
  payload: {
    contents: [
      { uri: 'memory://config', mimeType: 'text/plain', text: 'API_KEY=sk-live-abcd1234' },
    ],
  },
});
console.log('http redaction status=%s', redacted.status);
assert.equal(redacted.status, 'success');
const text = redacted.finalPayload?.contents?.[0]?.text ?? '';
assert.match(text, /\[REDACTED\]/);

// Wrap a backend client and run InterceptingClient.readResource against it,
// proving the client wrapper works regardless of the interceptor server's transport.
const backendServer = new Server(
  { name: 'mock-backend', version: '0.0.0' },
  { capabilities: { resources: {} } },
);
backendServer.setRequestHandler(ReadResourceRequestSchema, (req) => ({
  contents: [
    { uri: req.params.uri, mimeType: 'text/plain', text: 'API_KEY=sk-live-deadbeef' },
  ],
}));
const [bsT, bcT] = InMemoryTransport.createLinkedPair();
const backendClient = new Client({ name: 'b-c', version: '0.0.0' }, { capabilities: {} });
await Promise.all([backendServer.connect(bsT), backendClient.connect(bcT)]);

const intercepting = new InterceptingClient(backendClient, {
  interceptorClient: client,
  events: ['resources/read'],
});

let threw = false;
try {
  await intercepting.readResource({ uri: 'file:///etc/passwd' });
} catch (err) {
  threw = err instanceof McpInterceptorValidationError;
}
assert.ok(threw, 'expected McpInterceptorValidationError over HTTP');

const safe = await intercepting.readResource({ uri: 'memory://safe' });
const safeText = safe.contents[0].text ?? '';
console.log('http wrapped redaction text=%s', safeText);
assert.match(safeText, /\[REDACTED\]/);

await client.close();
await backendClient.close();
await backendServer.close();
console.log('http smoke-test OK');
process.exit(0);

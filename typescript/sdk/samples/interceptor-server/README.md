# Interceptor Server Sample

A Streamable HTTP MCP server that hosts six interceptors covering both `tools/call` and `resources/read`:

| Interceptor | Type | Mode | Event | Phase | Behavior |
|---|---|---|---|---|---|
| `pii-validator` | validation | active | `tools/call` | request | Block tool calls whose argument values match SSN or email patterns. |
| `arg-lowercaser` | mutation | active | `tools/call` | request | Lowercase all string args. `priorityHint: -1000`. |
| `tool-call-logger` | validation | audit (`failOpen: true`) | `tools/call` | both | Log tool name + payload size to stderr. |
| `resource-uri-guard` | validation | active | `resources/read` | request | Block reads of URIs matching `file:///etc/*` or `**/.env`. |
| `secret-redactor` | mutation | active | `resources/read` | response | Redact API-key-shaped strings from `contents[].text`. |
| `resource-read-logger` | validation | audit (`failOpen: true`) | `resources/read` | both | Log URI + payload size to stderr. |

The two loggers are SEP-2624 audit-mode validators — the spec's idiom for non-blocking observers. They never fail the chain; crashes are swallowed.

## Run

```bash
# from this directory
npm install
npm run build
npm start                              # http://localhost:39817/mcp
node dist/index.js --port=4000         # custom port
node dist/index.js --port=4000 --path=/api/mcp
```

Or directly via tsx (no build step):

```bash
npm run dev
```

The server runs in stateless mode: each POST gets a fresh `Server` + `StreamableHTTPServerTransport` pair, mirroring the SDK's `simpleStatelessStreamableHttp` example. `GET` and `DELETE` return 405 — only `POST` is supported.

## Smoke test

`smoke-test.mjs` connects to a running HTTP server (default `http://localhost:39817/mcp`) and exercises every interceptor end-to-end.

```bash
npm start &                # in one shell
node smoke-test.mjs        # in another
```

Or against a custom URL:

```bash
node smoke-test.mjs http://my-host:8080/mcp
```

## Standalone client example

Connect a plain `Client` over `StreamableHTTPClientTransport` and exercise the SEP methods directly:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  executeRemoteChain,
  listInterceptors,
} from '@ext-modelcontextprotocol/interceptors';

const transport = new StreamableHTTPClientTransport(
  new URL('http://localhost:39817/mcp'),
);
const client = new Client({ name: 'demo-client', version: '0.1.0' });
await client.connect(transport);

// Discover.
const list = await listInterceptors(client);
console.log(list.interceptors.map((i) => i.name));

// resources/read request phase: deny-listed URI is blocked.
const blocked = await executeRemoteChain([client], {
  event: 'resources/read',
  phase: 'request',
  payload: { uri: 'file:///etc/passwd' },
});
console.log(blocked.status);                 // 'validation_failed'
console.log(blocked.abortedAt?.interceptor); // 'resource-uri-guard'

// resources/read response phase: secret in contents is redacted.
const redacted = await executeRemoteChain([client], {
  event: 'resources/read',
  phase: 'response',
  payload: {
    contents: [
      { uri: 'memory://config', mimeType: 'text/plain', text: 'API_KEY=sk-live-abcd1234' },
    ],
  },
});
console.log(redacted.status);                 // 'success'
console.log((redacted.finalPayload as any).contents[0].text); // contains '[REDACTED]'
```

`executeRemoteChain` is the SDK-side helper per SEP-2624 — chain execution is local; remote interceptors are reached via repeated `interceptor/invoke` calls.

## Wrapped-client demo (`InterceptingClient`)

Spin up any backend MCP server that exposes one tool and one resource, then wrap its `Client`:

```ts
import { InterceptingClient } from '@ext-modelcontextprotocol/interceptors';

const intercepting = new InterceptingClient(backendClient, {
  interceptorClient: client, // the Client connected to this sample
  events: ['tools/call', 'resources/read'],
});

// Throws McpInterceptorValidationError because of resource-uri-guard.
await intercepting.readResource({ uri: 'file:///etc/passwd' });

// Returns the resource with API keys redacted by secret-redactor.
const safe = await intercepting.readResource({ uri: 'memory://config' });
```

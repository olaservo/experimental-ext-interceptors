# Interceptor Server Sample

A stdio MCP server that hosts six interceptors covering both `tools/call` and `resources/read`:

| Interceptor | Type | Event | Phase | Behavior |
|---|---|---|---|---|
| `pii-validator` | validation | `tools/call` | request | Block tool calls whose argument values match SSN or email patterns. |
| `arg-lowercaser` | mutation | `tools/call` | request | Lowercase all string args. `priorityHint: -1000`. |
| `tool-call-logger` | observability | `tools/call` | both | Log tool name + payload size to stderr. |
| `resource-uri-guard` | validation | `resources/read` | request | Block reads of URIs matching `file:///etc/*` or `**/.env`. |
| `secret-redactor` | mutation | `resources/read` | response | Redact API-key-shaped strings from `contents[].text`. |
| `resource-read-logger` | observability | `resources/read` | both | Log URI + payload size to stderr. |

## Run

```bash
# from this directory
npm install
npm run build
npm start                   # stdio server on stdin/stdout
node dist/index.js --http=39817   # Streamable HTTP server on http://localhost:39817/mcp
```

Or run directly via tsx:

```bash
npm run dev                       # stdio
npx tsx src/index.ts --http=39817 # HTTP
```

Two end-to-end smoke tests are checked in:

- `node smoke-test.mjs` — spawns the server over stdio and exercises every interceptor.
- `node smoke-test-http.mjs [url]` — connects to a running HTTP server (default `http://localhost:39817/mcp`) and exercises the same flows.

The HTTP variant runs in stateless mode (no `sessionIdGenerator`): each POST gets a fresh `Server` + `StreamableHTTPServerTransport` pair, mirroring the SDK's `simpleStatelessStreamableHttp` example. `GET` and `DELETE` return 405 — only `POST` is supported.

## Standalone client smoke test

Connect a plain `Client` (over `StdioClientTransport` pointing at this sample) and exercise the SEP methods directly:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  executeInterceptorChain,
  listInterceptors,
} from '@ext-modelcontextprotocol/interceptors';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
});
const client = new Client({ name: 'demo-client', version: '0.1.0' });
await client.connect(transport);

// Lists all 6 interceptors.
const list = await listInterceptors(client);
console.log(list.interceptors.map((i) => i.name));

// resources/read request phase: deny-listed URI is blocked.
const blocked = await executeInterceptorChain(client, {
  event: 'resources/read',
  phase: 'request',
  payload: { uri: 'file:///etc/passwd' },
});
console.log(blocked.status);                 // 'validation_failed'
console.log(blocked.abortedAt?.interceptor); // 'resource-uri-guard'

// resources/read response phase: secret in contents is redacted.
const redacted = await executeInterceptorChain(client, {
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

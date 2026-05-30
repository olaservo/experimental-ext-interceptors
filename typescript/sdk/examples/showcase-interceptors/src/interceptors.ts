// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//
// Ported from the fork's `samples/interceptor-server` onto Bob's PR #13 SDK.
// Logic (regexes, deny-list, redaction, lowercasing) preserved verbatim; only
// the SDK wiring changed:
//   - `defineInterceptor({…, invoke})`  → `RegisteredInterceptor` object form
//   - `InterceptorEvents`               → `InterceptionEvents`
//   - `ValidationResult.error/.success` → `validationFailure` / `validationSuccess`
//   - `MutationResult.unchanged/.mutated` → inline `{type:'mutation', phase, modified, payload}`
//   - audit-mode loggers (`mode:'audit'`) → `type:'sink'` returning a sink result
//
import {
  InterceptionEvents,
  validationFailure,
  validationSuccess,
  type RegisteredInterceptor,
} from '../../../dist/index.js';

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const API_KEY_PATTERN = /\b(sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{8,}\b/;
const RESOURCE_DENY_LIST = [/^file:\/\/\/etc\//, /^file:\/\/.*\/\.env(\.|$)/];

// ---------------------------------------------------------------------------
// tools/call interceptors
// ---------------------------------------------------------------------------

export const piiValidator: RegisteredInterceptor = {
  descriptor: {
    name: 'pii-validator',
    description:
      'Blocks tool calls whose argument values match SSN or email patterns.',
    type: 'validation',
    hooks: [{ events: [InterceptionEvents.ToolsCall], phase: 'request' }],
  },
  handler: (params) => {
    const json = JSON.stringify(params.payload ?? {});
    if (SSN_PATTERN.test(json)) {
      return validationFailure(params.phase, {
        path: '$.arguments',
        message: 'Tool call argument contains a Social Security Number.',
        severity: 'error',
      });
    }
    if (EMAIL_PATTERN.test(json)) {
      return validationFailure(params.phase, {
        path: '$.arguments',
        message: 'Tool call argument contains an email address.',
        severity: 'error',
      });
    }
    return validationSuccess(params.phase);
  },
};

export const argLowercaser: RegisteredInterceptor = {
  descriptor: {
    name: 'arg-lowercaser',
    description:
      'Lowercases all string values in tool call arguments. Runs before any other mutation (priority -1000).',
    type: 'mutation',
    hooks: [{ events: [InterceptionEvents.ToolsCall], phase: 'request' }],
    priorityHint: -1000,
  },
  handler: (params) => {
    const { payload, phase } = params;
    if (payload === null || typeof payload !== 'object' || !('arguments' in payload)) {
      return { type: 'mutation', phase, modified: false, payload };
    }
    const call = payload as { name: string; arguments?: Record<string, unknown> };
    if (!call.arguments) return { type: 'mutation', phase, modified: false, payload };
    let modified = false;
    const lowered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(call.arguments)) {
      if (typeof v === 'string') {
        const next = v.toLowerCase();
        if (next !== v) modified = true;
        lowered[k] = next;
      } else {
        lowered[k] = v;
      }
    }
    if (!modified) return { type: 'mutation', phase, modified: false, payload };
    return { type: 'mutation', phase, modified: true, payload: { ...call, arguments: lowered } };
  },
};

/**
 * Observer (sink): never blocks, logs to stderr per phase. `failOpen: true`
 * keeps a handler crash from aborting the chain.
 */
export const toolCallLogger: RegisteredInterceptor = {
  descriptor: {
    name: 'tool-call-logger',
    description: 'Logs tool name and payload size for every tools/call.',
    type: 'sink',
    failOpen: true,
    hooks: [
      { events: [InterceptionEvents.ToolsCall], phase: 'request' },
      { events: [InterceptionEvents.ToolsCall], phase: 'response' },
    ],
  },
  handler: (params) => {
    const json = JSON.stringify(params.payload ?? {});
    const name =
      typeof params.payload === 'object' && params.payload && 'name' in params.payload
        ? String((params.payload as { name: unknown }).name)
        : '<unknown>';
    process.stderr.write(
      `[interceptor] tools/call phase=${params.phase} name=${name} bytes=${json.length}\n`,
    );
    return { type: 'sink', phase: params.phase, recorded: true, metrics: { payloadBytes: json.length } };
  },
};

// ---------------------------------------------------------------------------
// resources/read interceptors
// ---------------------------------------------------------------------------

export const resourceUriGuard: RegisteredInterceptor = {
  descriptor: {
    name: 'resource-uri-guard',
    description:
      'Blocks reads of URIs matching deny-list patterns (e.g. file:///etc/*, file:///**/.env).',
    type: 'validation',
    hooks: [{ events: [InterceptionEvents.ResourcesRead], phase: 'request' }],
  },
  handler: (params) => {
    const uri =
      params.payload && typeof params.payload === 'object' && 'uri' in params.payload
        ? String((params.payload as { uri: unknown }).uri)
        : undefined;
    if (!uri) return validationSuccess(params.phase);
    for (const pattern of RESOURCE_DENY_LIST) {
      if (pattern.test(uri)) {
        return validationFailure(params.phase, {
          path: '$.uri',
          message: `Resource URI '${uri}' is on the deny list.`,
          severity: 'error',
        });
      }
    }
    return validationSuccess(params.phase);
  },
};

export const secretRedactor: RegisteredInterceptor = {
  descriptor: {
    name: 'secret-redactor',
    description:
      'Redacts API-key-shaped strings from resource contents before they reach the caller.',
    type: 'mutation',
    hooks: [{ events: [InterceptionEvents.ResourcesRead], phase: 'response' }],
    priorityHint: -500,
  },
  handler: (params) => {
    const { payload, phase } = params;
    if (!payload || typeof payload !== 'object' || !('contents' in payload)) {
      return { type: 'mutation', phase, modified: false, payload };
    }
    const result = payload as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>;
    };
    if (!Array.isArray(result.contents)) {
      return { type: 'mutation', phase, modified: false, payload };
    }
    let modified = false;
    const nextContents = result.contents.map((c) => {
      if (typeof c.text !== 'string') return c;
      const redacted = c.text.replace(API_KEY_PATTERN, '[REDACTED]');
      if (redacted === c.text) return c;
      modified = true;
      return { ...c, text: redacted };
    });
    if (!modified) return { type: 'mutation', phase, modified: false, payload };
    return { type: 'mutation', phase, modified: true, payload: { ...result, contents: nextContents } };
  },
};

export const resourceReadLogger: RegisteredInterceptor = {
  descriptor: {
    name: 'resource-read-logger',
    description: 'Logs URI and byte count for every resources/read.',
    type: 'sink',
    failOpen: true,
    hooks: [
      { events: [InterceptionEvents.ResourcesRead], phase: 'request' },
      { events: [InterceptionEvents.ResourcesRead], phase: 'response' },
    ],
  },
  handler: (params) => {
    const json = JSON.stringify(params.payload ?? {});
    const uri =
      params.payload && typeof params.payload === 'object' && 'uri' in params.payload
        ? String((params.payload as { uri: unknown }).uri)
        : undefined;
    process.stderr.write(
      `[interceptor] resources/read phase=${params.phase} uri=${uri ?? '<n/a>'} bytes=${json.length}\n`,
    );
    return { type: 'sink', phase: params.phase, recorded: true, metrics: { payloadBytes: json.length } };
  },
};

export const allInterceptors: RegisteredInterceptor[] = [
  piiValidator,
  argLowercaser,
  toolCallLogger,
  resourceUriGuard,
  secretRedactor,
  resourceReadLogger,
];

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import {
  defineInterceptor,
  InterceptorEvents,
  MutationResult,
  ValidationResult,
  type McpInterceptor,
} from '@ext-modelcontextprotocol/interceptors';

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const API_KEY_PATTERN = /\b(sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{8,}\b/;
const RESOURCE_DENY_LIST = [
  /^file:\/\/\/etc\//,
  /^file:\/\/.*\/\.env(\.|$)/,
];

// ---------------------------------------------------------------------------
// tools/call interceptors
// ---------------------------------------------------------------------------

export const piiValidator: McpInterceptor = defineInterceptor({
  name: 'pii-validator',
  description:
    'Blocks tool calls whose argument values match SSN or email patterns.',
  type: 'validation',
  events: [InterceptorEvents.ToolsCall],
  phase: 'request',
  invoke: ({ payload }) => {
    const json = JSON.stringify(payload ?? {});
    if (SSN_PATTERN.test(json)) {
      return ValidationResult.error(
        'Tool call argument contains a Social Security Number.',
        '$.arguments',
      );
    }
    if (EMAIL_PATTERN.test(json)) {
      return ValidationResult.error(
        'Tool call argument contains an email address.',
        '$.arguments',
      );
    }
    return ValidationResult.success();
  },
});

export const argLowercaser: McpInterceptor = defineInterceptor({
  name: 'arg-lowercaser',
  description:
    'Lowercases all string values in tool call arguments. Runs before any other mutation (priority -1000).',
  type: 'mutation',
  events: [InterceptorEvents.ToolsCall],
  phase: 'request',
  priorityHint: -1000,
  invoke: ({ payload }) => {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !('arguments' in payload)
    ) {
      return MutationResult.unchanged(payload);
    }
    const params = payload as { name: string; arguments?: Record<string, unknown> };
    if (!params.arguments) return MutationResult.unchanged(payload);
    let modified = false;
    const lowered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params.arguments)) {
      if (typeof v === 'string') {
        const next = v.toLowerCase();
        if (next !== v) modified = true;
        lowered[k] = next;
      } else {
        lowered[k] = v;
      }
    }
    if (!modified) return MutationResult.unchanged(payload);
    return MutationResult.mutated({ ...params, arguments: lowered });
  },
});

/**
 * Audit-mode validator (the SEP-2624 idiom for an observer): never blocks,
 * crashes don't abort the chain (`failOpen: true`). Logs to stderr per phase.
 */
export const toolCallLogger: McpInterceptor = defineInterceptor({
  name: 'tool-call-logger',
  description: 'Logs tool name and payload size for every tools/call.',
  type: 'validation',
  mode: 'audit',
  failOpen: true,
  hooks: [
    { events: [InterceptorEvents.ToolsCall], phase: 'request' },
    { events: [InterceptorEvents.ToolsCall], phase: 'response' },
  ],
  invoke: ({ payload, phase }) => {
    const json = JSON.stringify(payload ?? {});
    const name =
      typeof payload === 'object' && payload && 'name' in payload
        ? String((payload as { name: unknown }).name)
        : '<unknown>';
    process.stderr.write(
      `[interceptor] tools/call phase=${phase} name=${name} bytes=${json.length}\n`,
    );
    return ValidationResult.success();
  },
});

// ---------------------------------------------------------------------------
// resources/read interceptors
// ---------------------------------------------------------------------------

export const resourceUriGuard: McpInterceptor = defineInterceptor({
  name: 'resource-uri-guard',
  description:
    'Blocks reads of URIs matching deny-list patterns (e.g. file:///etc/*, file:///**/.env).',
  type: 'validation',
  events: [InterceptorEvents.ResourcesRead],
  phase: 'request',
  invoke: ({ payload }) => {
    const uri =
      payload && typeof payload === 'object' && 'uri' in payload
        ? String((payload as { uri: unknown }).uri)
        : undefined;
    if (!uri) return ValidationResult.success();
    for (const pattern of RESOURCE_DENY_LIST) {
      if (pattern.test(uri)) {
        return ValidationResult.error(
          `Resource URI '${uri}' is on the deny list.`,
          '$.uri',
        );
      }
    }
    return ValidationResult.success();
  },
});

export const secretRedactor: McpInterceptor = defineInterceptor({
  name: 'secret-redactor',
  description:
    'Redacts API-key-shaped strings from resource contents before they reach the caller.',
  type: 'mutation',
  events: [InterceptorEvents.ResourcesRead],
  phase: 'response',
  priorityHint: -500,
  invoke: ({ payload }) => {
    if (!payload || typeof payload !== 'object' || !('contents' in payload)) {
      return MutationResult.unchanged(payload);
    }
    const result = payload as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>;
    };
    if (!Array.isArray(result.contents)) return MutationResult.unchanged(payload);
    let modified = false;
    const nextContents = result.contents.map((c) => {
      if (typeof c.text !== 'string') return c;
      const redacted = c.text.replace(API_KEY_PATTERN, '[REDACTED]');
      if (redacted === c.text) return c;
      modified = true;
      return { ...c, text: redacted };
    });
    if (!modified) return MutationResult.unchanged(payload);
    return MutationResult.mutated({ ...result, contents: nextContents });
  },
});

export const resourceReadLogger: McpInterceptor = defineInterceptor({
  name: 'resource-read-logger',
  description: 'Logs URI and byte count for every resources/read.',
  type: 'validation',
  mode: 'audit',
  failOpen: true,
  hooks: [
    { events: [InterceptorEvents.ResourcesRead], phase: 'request' },
    { events: [InterceptorEvents.ResourcesRead], phase: 'response' },
  ],
  invoke: ({ payload, phase }) => {
    const json = JSON.stringify(payload ?? {});
    const uri =
      payload && typeof payload === 'object' && 'uri' in payload
        ? String((payload as { uri: unknown }).uri)
        : undefined;
    process.stderr.write(
      `[interceptor] resources/read phase=${phase} uri=${uri ?? '<n/a>'} bytes=${json.length}\n`,
    );
    return ValidationResult.success();
  },
});

export const allInterceptors: McpInterceptor[] = [
  piiValidator,
  argLowercaser,
  toolCallLogger,
  resourceUriGuard,
  secretRedactor,
  resourceReadLogger,
];

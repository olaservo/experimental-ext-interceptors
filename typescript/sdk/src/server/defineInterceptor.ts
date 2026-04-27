// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type {
  Interceptor,
  InterceptorHook,
  InterceptorMode,
  InterceptorPhase,
  InterceptorResult,
  InvokeInterceptorContext,
} from '../protocol/index.js';
import type {
  InterceptorInvocationContext,
  McpInterceptor,
} from '../runtime/interceptor.js';

/**
 * Two ways to declare what an interceptor hooks into:
 *
 * - The full SEP-2624 form: `hooks: [{ events, phase }, ...]`
 * - A shorthand: `events: [...], phase: 'request' | 'response'` — promoted to a
 *   single-entry `hooks` array internally. `events` defaults to `['*']` if
 *   omitted; `phase` defaults to `'request'`.
 *
 * Use the full form to register an interceptor on multiple phases at once
 * (the only way per SEP — there is no `'both'` phase value).
 */
export type DefineInterceptorOptions = Omit<Interceptor, 'hooks'> & {
  hooks?: InterceptorHook[];
  events?: string[];
  phase?: InterceptorPhase;
  invoke: (
    ctx: InterceptorInvocationContext,
  ) => InterceptorResult | Promise<InterceptorResult>;
};

/**
 * Define an interceptor: protocol metadata plus an invocation callback.
 *
 * The returned object is what an interceptor server hosts via
 * {@link withInterceptors} and what the chain executor runs.
 *
 * @example
 * ```ts
 * const piiValidator = defineInterceptor({
 *   name: 'pii-validator',
 *   type: 'validation',
 *   events: [InterceptorEvents.ToolsCall],
 *   phase: 'request',
 *   invoke: ({ payload }) => {
 *     if (containsSsn(payload)) return ValidationResult.error('SSN detected');
 *     return ValidationResult.success();
 *   },
 * });
 *
 * // Or fire on both phases:
 * const logger = defineInterceptor({
 *   name: 'logger',
 *   type: 'validation',
 *   mode: 'audit',
 *   failOpen: true,
 *   hooks: [
 *     { events: ['tools/call'], phase: 'request' },
 *     { events: ['tools/call'], phase: 'response' },
 *   ],
 *   invoke: ({ event, phase }) => {
 *     console.error(`[log] ${event} ${phase}`);
 *     return ValidationResult.success();
 *   },
 * });
 * ```
 */
export function defineInterceptor(opts: DefineInterceptorOptions): McpInterceptor {
  const { invoke, hooks, events, phase, ...rest } = opts;
  const resolvedHooks: InterceptorHook[] = hooks ?? [
    {
      events: events ?? ['*'],
      phase: phase ?? 'request',
    },
  ];
  const metadata: Interceptor = { ...rest, hooks: resolvedHooks };
  return { metadata, invoke };
}

// Re-export for callers that want to type their own helpers.
export type {
  InterceptorMode,
  InterceptorInvocationContext,
  InvokeInterceptorContext,
  McpInterceptor,
};

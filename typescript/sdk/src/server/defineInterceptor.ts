// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type {
  Interceptor,
  InterceptorPhase,
  InterceptorResult,
  InvokeInterceptorContext,
} from '../protocol/index.js';
import type {
  InterceptorInvocationContext,
  McpInterceptor,
} from '../runtime/interceptor.js';

export interface DefineInterceptorOptions extends Omit<Interceptor, 'phase'> {
  /** Defaults to `'request'` if omitted, matching the C# attribute default. */
  phase?: InterceptorPhase;
  invoke: (
    ctx: InterceptorInvocationContext,
  ) => InterceptorResult | Promise<InterceptorResult>;
}

/**
 * Define an interceptor: protocol metadata plus an invocation callback.
 *
 * The returned object is what an interceptor server hosts via {@link withInterceptors}
 * and what the chain executor runs.
 *
 * Mirrors the user experience of decorating a C# method with `[McpServerInterceptor(...)]`,
 * but as a plain factory call so it works in ESM without decorator metadata setup.
 *
 * @example
 * ```ts
 * const piiValidator = defineInterceptor({
 *   name: 'pii-validator',
 *   events: [InterceptorEvents.ToolsCall],
 *   type: 'validation',
 *   phase: 'request',
 *   priorityHint: -1000,
 *   invoke: ({ payload }) => {
 *     if (containsSsn(payload)) return ValidationResult.error('SSN detected');
 *     return ValidationResult.success();
 *   },
 * });
 * ```
 */
export function defineInterceptor(opts: DefineInterceptorOptions): McpInterceptor {
  const { invoke, phase, ...rest } = opts;
  const metadata: Interceptor = { ...rest, phase: phase ?? 'request' };
  return {
    metadata,
    invoke,
  };
}

// Re-export for callers that want to type their own helpers.
export type { InvokeInterceptorContext, InterceptorInvocationContext, McpInterceptor };

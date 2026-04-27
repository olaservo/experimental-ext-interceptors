// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type {
  Interceptor,
  InterceptorPhase,
  InterceptorResult,
  InvokeInterceptorContext,
} from '../protocol/index.js';

/**
 * Context passed to a local interceptor's `invoke` callback.
 */
export interface InterceptorInvocationContext {
  payload: unknown;
  config?: unknown;
  event: string;
  phase: InterceptorPhase;
  context?: InvokeInterceptorContext;
  signal?: AbortSignal;
}

/**
 * A locally-defined interceptor — metadata plus an invocation callback.
 *
 * This is what an interceptor server hosts and what the chain executor runs.
 * Created via {@link defineInterceptor}.
 */
export interface McpInterceptor {
  readonly metadata: Interceptor;
  invoke(
    ctx: InterceptorInvocationContext,
  ): InterceptorResult | Promise<InterceptorResult>;
}

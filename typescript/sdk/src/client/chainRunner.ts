// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type InterceptorChainStatus,
  type InterceptorPhase,
  type InvokeInterceptorContext,
  McpInterceptorValidationError,
  type InterceptorChainResult,
} from '../protocol/index.js';
import { executeInterceptorChain } from './interceptorClientHelpers.js';

/**
 * Runs an interceptor chain phase across one or more interceptor server clients in order.
 * Each client's `interceptor/executeChain` receives the previous client's mutated payload.
 *
 * Mirrors the C# `Gateway/InterceptorChainRunner.cs` semantics, but consumed by both
 * the {@link InterceptingClient} wrapper and the gateway transparent proxy.
 */
export class InterceptorChainRunner {
  constructor(
    private readonly clients: readonly Client[],
    private readonly events: readonly string[] | undefined,
    private readonly timeoutMs: number | undefined,
    private readonly defaultContext: InvokeInterceptorContext | undefined,
  ) {}

  shouldIntercept(eventName: string): boolean {
    if (!this.events || this.events.length === 0) return true;
    return this.events.includes(eventName);
  }

  /**
   * Runs the chain phase across all configured clients sequentially. Returns the
   * payload after the last successful client and the resulting status. Stops on
   * the first non-success status.
   */
  async runPhase(args: {
    event: string;
    phase: InterceptorPhase;
    payload: unknown;
  }): Promise<{
    payload: unknown;
    status: InterceptorChainStatus;
    chainResult?: InterceptorChainResult;
  }> {
    let current = args.payload;
    let lastResult: InterceptorChainResult | undefined;

    for (const client of this.clients) {
      const result = await executeInterceptorChain(client, {
        event: args.event,
        phase: args.phase,
        payload: current,
        timeoutMs: this.timeoutMs,
        context: this.defaultContext,
      });
      lastResult = result;
      if (result.status !== 'success') {
        return { payload: current, status: result.status, chainResult: result };
      }
      current = result.finalPayload ?? current;
    }

    return { payload: current, status: 'success', chainResult: lastResult };
  }
}

/**
 * Throws an appropriate error for a non-success chain status.
 *
 * Validation failures throw {@link McpInterceptorValidationError}; everything else
 * throws a generic `Error`.
 */
export function throwChainFailure(args: {
  operation: string;
  phase: InterceptorPhase;
  status: InterceptorChainStatus;
  chainResult?: InterceptorChainResult;
}): never {
  const phaseText = args.phase === 'request' ? 'Request' : 'Response';
  if (args.status === 'validation_failed') {
    const messages =
      args.chainResult?.results.flatMap((r) =>
        r.type === 'validation' ? (r.messages ?? []) : [],
      ) ?? [];
    throw new McpInterceptorValidationError(
      `${phaseText}-phase interceptor validation failed for ${args.operation}.`,
      { validationMessages: messages, chainResult: args.chainResult },
    );
  }
  throw new Error(
    `${phaseText}-phase interceptor chain failed for ${args.operation} with status '${args.status}'.`,
  );
}

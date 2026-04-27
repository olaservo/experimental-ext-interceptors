// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type ChainExecutionResult,
  type InterceptorChainStatus,
  type InterceptorPhase,
  type InvokeInterceptorContext,
  McpInterceptorValidationError,
} from '../protocol/index.js';
import { executeRemoteChain } from './interceptorClientHelpers.js';

/**
 * Runs an interceptor chain phase across one or more interceptor server
 * clients. Discovery + ordering + invocation happen client-side per SEP-2624;
 * each interceptor is reached via `interceptor/invoke` (there is no wire-level
 * `executeChain`).
 *
 * Used by both {@link InterceptingClient} and the gateway transparent proxy.
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
   * Run a single chain phase across all configured interceptor clients. The
   * SDK helper merges them into one chain ordered by SEP-2624 priority rules.
   */
  async runPhase(args: {
    event: string;
    phase: InterceptorPhase;
    payload: unknown;
  }): Promise<{
    payload: unknown;
    status: InterceptorChainStatus;
    chainResult?: ChainExecutionResult;
  }> {
    const result = await executeRemoteChain(this.clients, {
      event: args.event,
      phase: args.phase,
      payload: args.payload,
      timeoutMs: this.timeoutMs,
      context: this.defaultContext,
    });
    return {
      payload: result.finalPayload ?? args.payload,
      status: result.status,
      chainResult: result,
    };
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
  chainResult?: ChainExecutionResult;
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

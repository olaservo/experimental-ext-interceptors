// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  INTERCEPTOR_CAPABILITY_KEY,
  type Interceptor,
  type InterceptorChainResult,
  type InterceptorResult,
  type ListInterceptorsResult,
  type InvokeInterceptorRequestParams,
  type ExecuteChainRequestParams,
} from '../protocol/index.js';
import { executeChain } from '../runtime/chainExecutor.js';
import { matchesEvent } from '../runtime/eventMatching.js';
import type { McpInterceptor } from '../runtime/interceptor.js';
import {
  ExecuteChainRequestSchema,
  InvokeInterceptorRequestSchema,
  ListInterceptorsRequestSchema,
} from './schemas.js';

export interface WithInterceptorsOptions {
  /**
   * Interceptors to host. Their metadata is exposed via `interceptors/list`,
   * individual ones can be invoked via `interceptor/invoke`, and the full set
   * can be run as a chain via `interceptor/executeChain`.
   */
  interceptors: McpInterceptor[];
}

/**
 * Wires the MCP interceptors extension onto a `Server` from `@modelcontextprotocol/sdk`.
 *
 * Registers handlers for `interceptors/list`, `interceptor/invoke`, and
 * `interceptor/executeChain`, and overlays the `interceptors` capability under
 * `experimental` (mirroring the C# SDK's placement under `Extensions["interceptors"]`).
 */
export function withInterceptors(
  server: Server,
  options: WithInterceptorsOptions,
): void {
  const { interceptors } = options;

  // Advertise the capability. The TS SDK exposes `experimental` as a
  // `Record<string, object>`, which is the same slot the C# SDK uses for
  // protocol extensions (`Extensions["interceptors"]`).
  const supportedEvents = collectSupportedEvents(interceptors);
  server.registerCapabilities({
    experimental: {
      [INTERCEPTOR_CAPABILITY_KEY]: { supportedEvents },
    },
  });

  server.setRequestHandler(
    ListInterceptorsRequestSchema,
    (request): ListInterceptorsResult => {
      const filter = request.params?.event;
      const list: Interceptor[] = interceptors
        .filter((i) =>
          filter ? matchesEvent(i.metadata.events, filter) : true,
        )
        .map((i) => i.metadata);
      return { interceptors: list };
    },
  );

  server.setRequestHandler(
    InvokeInterceptorRequestSchema,
    async (request, extra): Promise<InterceptorResult> => {
      const params: InvokeInterceptorRequestParams = request.params;
      const interceptor = interceptors.find(
        (i) => i.metadata.name === params.name,
      );
      if (!interceptor) {
        throw new Error(`Interceptor '${params.name}' not found`);
      }

      const timeoutController = params.timeoutMs
        ? new AbortController()
        : undefined;
      const handle = timeoutController
        ? setTimeout(() => timeoutController.abort(), params.timeoutMs)
        : undefined;

      const signals: AbortSignal[] = [extra.signal];
      if (timeoutController) signals.push(timeoutController.signal);
      const signal =
        signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      try {
        const t0 = Date.now();
        const result = await interceptor.invoke({
          payload: params.payload,
          config: params.config,
          event: params.event,
          phase: params.phase,
          context: params.context,
          signal,
        });
        return {
          ...result,
          interceptor: interceptor.metadata.name,
          phase: params.phase,
          durationMs: Date.now() - t0,
        };
      } finally {
        if (handle) clearTimeout(handle);
      }
    },
  );

  server.setRequestHandler(
    ExecuteChainRequestSchema,
    async (request, extra): Promise<InterceptorChainResult> => {
      const params: ExecuteChainRequestParams = request.params;
      return executeChain(interceptors, params, extra.signal);
    },
  );
}

function collectSupportedEvents(interceptors: McpInterceptor[]): string[] {
  const set = new Set<string>();
  for (const i of interceptors) {
    for (const ev of i.metadata.events) set.add(ev);
  }
  return [...set];
}

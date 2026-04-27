// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  INTERCEPTOR_CAPABILITY_KEY,
  type Interceptor,
  type InterceptorMode,
  type InterceptorResult,
  type InvokeInterceptorRequestParams,
  type ListInterceptorsResult,
} from '../protocol/index.js';
import { matchesEvent } from '../runtime/eventMatching.js';
import type { McpInterceptor } from '../runtime/interceptor.js';
import {
  InvokeInterceptorRequestSchema,
  ListInterceptorsRequestSchema,
} from './schemas.js';

export interface WithInterceptorsOptions {
  /**
   * Interceptors to host. Their metadata is exposed via `interceptors/list`,
   * individual ones can be invoked via `interceptor/invoke`. Per SEP-2624 there
   * is no `interceptor/executeChain` wire method — chain execution is an
   * SDK-side helper (see `executeChain` and `executeRemoteChain`).
   */
  interceptors: McpInterceptor[];
}

/**
 * Wires the MCP interceptors extension onto a `Server` from `@modelcontextprotocol/sdk`.
 *
 * Registers handlers for the two SEP-2624 wire methods (`interceptors/list`
 * and `interceptor/invoke`) and overlays the `interceptor` capability under
 * `experimental` (the SEP places it at top-level; the TS SDK's
 * `ServerCapabilities` schema strips unknown top-level fields, so we nest it).
 */
export function withInterceptors(
  server: Server,
  options: WithInterceptorsOptions,
): void {
  const { interceptors } = options;

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
          filter
            ? i.metadata.hooks.some((h) => matchesEvent(h.events, filter))
            : true,
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
        const mode: InterceptorMode = interceptor.metadata.mode ?? 'active';
        return {
          ...result,
          interceptor: interceptor.metadata.name,
          phase: params.phase,
          mode,
          durationMs: Date.now() - t0,
        };
      } finally {
        if (handle) clearTimeout(handle);
      }
    },
  );
}

function collectSupportedEvents(interceptors: McpInterceptor[]): string[] {
  const set = new Set<string>();
  for (const i of interceptors) {
    for (const hook of i.metadata.hooks) {
      for (const ev of hook.events) set.add(ev);
    }
  }
  return [...set];
}

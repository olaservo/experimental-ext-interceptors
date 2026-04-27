// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type ChainExecutionParams,
  type ChainExecutionResult,
  type Interceptor,
  type InterceptorMode,
  type InterceptorResult,
  type InvokeInterceptorRequestParams,
  type ListInterceptorsRequestParams,
  type ListInterceptorsResult,
  InterceptorRequestMethods,
  InterceptorResultSchema,
  InvokeInterceptorRequestParamsSchema,
  ListInterceptorsRequestParamsSchema,
  ListInterceptorsResultSchema,
  resolvePriority,
} from '../protocol/index.js';
import { matchesEvent } from '../runtime/eventMatching.js';

/**
 * Calls `interceptors/list` on the connected interceptor server.
 */
export async function listInterceptors(
  client: Client,
  params?: ListInterceptorsRequestParams,
): Promise<ListInterceptorsResult> {
  const validated = params ? ListInterceptorsRequestParamsSchema.parse(params) : {};
  return client.request(
    {
      method: InterceptorRequestMethods.InterceptorsList,
      params: validated,
    },
    ListInterceptorsResultSchema,
  );
}

/**
 * Calls `interceptor/invoke` on the connected interceptor server.
 */
export async function invokeInterceptor(
  client: Client,
  params: InvokeInterceptorRequestParams,
): Promise<InterceptorResult> {
  const validated = InvokeInterceptorRequestParamsSchema.parse(params);
  return client.request(
    {
      method: InterceptorRequestMethods.InterceptorInvoke,
      params: validated,
    },
    InterceptorResultSchema,
  );
}

// ---------------------------------------------------------------------------
// SDK-side chain execution. SEP-2624 says chain execution is a CONVENIENCE
// UTILITY in the SDK — it is NOT a wire method. The implementation below
// discovers interceptors via `interceptors/list`, orders them by the SEP
// execution model, and runs them via repeated `interceptor/invoke` calls.
// ---------------------------------------------------------------------------

/**
 * Run a chain phase against one or more interceptor servers, applying the
 * SEP-2624 execution model client-side. Each server's interceptors are
 * discovered via `interceptors/list`, then dispatched via `interceptor/invoke`.
 *
 * Interceptors from multiple clients are merged into one chain and ordered by
 * `priorityHint` (ascending, alphabetical tiebreak), per SEP-2624 §"Chain
 * Execution".
 */
export async function executeRemoteChain(
  clients: readonly Client[],
  params: ChainExecutionParams,
): Promise<ChainExecutionResult> {
  const start = Date.now();
  const results: InterceptorResult[] = [];
  const summary = { errors: 0, warnings: 0, infos: 0 };
  let payload = params.payload;

  // 1. Discover and merge interceptors across all clients, filtered by event/phase.
  const entries: Array<{ client: Client; meta: Interceptor }> = [];
  for (const client of clients) {
    const list = await listInterceptors(client, { event: params.event });
    for (const meta of list.interceptors) {
      if (params.interceptors && !params.interceptors.includes(meta.name)) continue;
      const matches = meta.hooks.some(
        (h) => h.phase === params.phase && matchesEvent(h.events, params.event),
      );
      if (matches) entries.push({ client, meta });
    }
  }

  // 2. Bucket and order. Mutations: sequential by priority. Validations: parallel.
  const mutations = entries
    .filter((e) => e.meta.type === 'mutation')
    .sort((a, b) => {
      const pa = resolvePriority(a.meta.priorityHint, params.phase);
      const pb = resolvePriority(b.meta.priorityHint, params.phase);
      if (pa !== pb) return pa - pb;
      return a.meta.name < b.meta.name ? -1 : 1;
    });
  const validations = entries.filter((e) => e.meta.type === 'validation');

  // 3. Run per the trust-boundary-aware order:
  //    request:  mutations -> validations
  //    response: validations -> mutations
  let status: ChainExecutionResult['status'] = 'success';
  let abortedAt: ChainExecutionResult['abortedAt'];

  const runMutations = async (): Promise<boolean> => {
    for (const { client, meta } of mutations) {
      const mode: InterceptorMode = meta.mode ?? 'active';
      try {
        const r = await invokeInterceptor(client, {
          name: meta.name,
          event: params.event,
          phase: params.phase,
          payload,
          config: extractConfig(params, meta.name),
          timeoutMs: params.timeoutMs,
          context: params.context,
        });
        results.push(r);
        if (mode === 'active' && r.type === 'mutation' && r.modified && r.payload !== undefined) {
          payload = r.payload;
        }
      } catch (err) {
        if (mode === 'audit' || meta.failOpen) {
          results.push({
            type: 'mutation',
            interceptor: meta.name,
            phase: params.phase,
            mode,
            modified: false,
            info: { error: err instanceof Error ? err.message : String(err) },
          });
          continue;
        }
        status = 'mutation_failed';
        abortedAt = {
          interceptor: meta.name,
          reason: err instanceof Error ? err.message : String(err),
          type: 'mutation',
        };
        return false;
      }
    }
    return true;
  };

  const runValidations = async (): Promise<boolean> => {
    const settled = await Promise.all(
      validations.map(async ({ client, meta }) => {
        const mode: InterceptorMode = meta.mode ?? 'active';
        try {
          const r = await invokeInterceptor(client, {
            name: meta.name,
            event: params.event,
            phase: params.phase,
            payload,
            config: extractConfig(params, meta.name),
            timeoutMs: params.timeoutMs,
            context: params.context,
          });
          return { meta, mode, result: r };
        } catch (err) {
          if (mode === 'audit' || meta.failOpen) {
            const synthetic: InterceptorResult = {
              type: 'validation',
              interceptor: meta.name,
              phase: params.phase,
              mode,
              valid: true,
              info: { error: err instanceof Error ? err.message : String(err) },
            };
            return { meta, mode, result: synthetic };
          }
          throw err;
        }
      }),
    );
    let outcomeOk = true;
    for (const { meta, mode, result } of settled) {
      results.push(result);
      if (result.type === 'validation') {
        if (result.messages) {
          for (const msg of result.messages) {
            if (msg.severity === 'error') summary.errors++;
            else if (msg.severity === 'warn') summary.warnings++;
            else summary.infos++;
          }
        }
        if (
          mode === 'active' &&
          !result.valid &&
          result.severity === 'error' &&
          outcomeOk
        ) {
          status = 'validation_failed';
          abortedAt = {
            interceptor: meta.name,
            reason: result.messages?.[0]?.message ?? 'Validation failed',
            type: 'validation',
          };
          outcomeOk = false;
        }
      }
    }
    return outcomeOk;
  };

  if (params.phase === 'request') {
    const ok = await runMutations();
    if (ok) await runValidations();
  } else {
    const ok = await runValidations();
    if (ok) await runMutations();
  }

  return {
    status,
    event: params.event,
    phase: params.phase,
    results,
    finalPayload: payload,
    validationSummary: summary,
    totalDurationMs: Date.now() - start,
    abortedAt,
  };
}

function extractConfig(params: ChainExecutionParams, name: string): unknown {
  const cfg = params.config;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    return (cfg as Record<string, unknown>)[name];
  }
  return undefined;
}

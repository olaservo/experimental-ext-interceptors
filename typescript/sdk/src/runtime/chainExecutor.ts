// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import {
  type ChainAbortInfo,
  type ChainValidationSummary,
  type ExecuteChainRequestParams,
  type InterceptorChainResult,
  type InterceptorChainStatus,
  type InterceptorPhase,
  type InterceptorResult,
  ObservabilityResult,
} from '../protocol/index.js';
import { matchesEvent } from './eventMatching.js';
import type { McpInterceptor } from './interceptor.js';

/**
 * Executes a list of locally-defined interceptors according to SEP-1763.
 *
 * Sending (request phase): mutations (sequential, ascending priority) →
 *   validations (parallel) → observability (parallel, fire-and-forget).
 * Receiving (response phase): validations (parallel) →
 *   observability (parallel, fire-and-forget) → mutations (sequential).
 *
 * Mirrors C# `Server/InterceptorChainExecutor.cs`.
 */
export async function executeChain(
  interceptors: readonly McpInterceptor[],
  params: ExecuteChainRequestParams,
  signal?: AbortSignal,
): Promise<InterceptorChainResult> {
  const start = Date.now();
  const results: InterceptorResult[] = [];
  const summary: ChainValidationSummary = { errors: 0, warnings: 0, infos: 0 };
  let currentPayload = params.payload;
  let abortInfo: ChainAbortInfo | undefined;
  let status: InterceptorChainStatus = 'success';

  const applicable = filterInterceptors(interceptors, params);
  const mutations = applicable
    .filter((i) => i.metadata.type === 'mutation')
    .sort((a, b) => {
      const pa = a.metadata.priorityHint ?? 0;
      const pb = b.metadata.priorityHint ?? 0;
      if (pa !== pb) return pa - pb;
      return a.metadata.name < b.metadata.name ? -1 : 1;
    });
  const validations = applicable.filter((i) => i.metadata.type === 'validation');
  const observability = applicable.filter(
    (i) => i.metadata.type === 'observability',
  );

  const timeoutController = params.timeoutMs
    ? new AbortController()
    : undefined;
  const timeoutHandle = timeoutController
    ? setTimeout(() => timeoutController.abort(), params.timeoutMs)
    : undefined;

  // Combine the inbound signal with the timeout signal.
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutController) signals.push(timeoutController.signal);
  const effectiveSignal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  try {
    if (params.phase === 'request') {
      const mutResult = await runMutations(
        mutations,
        params,
        currentPayload,
        results,
        effectiveSignal,
      );
      currentPayload = mutResult.payload;
      if (mutResult.status !== 'success') {
        status = mutResult.status;
        abortInfo = mutResult.abort;
      } else {
        const valResult = await runValidations(
          validations,
          params,
          currentPayload,
          results,
          summary,
          effectiveSignal,
        );
        if (valResult.status !== 'success') {
          status = valResult.status;
          abortInfo = valResult.abort;
        } else {
          await runObservability(
            observability,
            params,
            currentPayload,
            results,
            effectiveSignal,
          );
        }
      }
    } else {
      // 'response' or 'both' (chain executes per-phase, so 'both' is unusual here)
      const valResult = await runValidations(
        validations,
        params,
        currentPayload,
        results,
        summary,
        effectiveSignal,
      );
      if (valResult.status !== 'success') {
        status = valResult.status;
        abortInfo = valResult.abort;
      } else {
        await runObservability(
          observability,
          params,
          currentPayload,
          results,
          effectiveSignal,
        );
        const mutResult = await runMutations(
          mutations,
          params,
          currentPayload,
          results,
          effectiveSignal,
        );
        currentPayload = mutResult.payload;
        if (mutResult.status !== 'success') {
          status = mutResult.status;
          abortInfo = mutResult.abort;
        }
      }
    }
  } catch (err) {
    if (timeoutController?.signal.aborted) {
      status = 'timeout';
    } else {
      throw err;
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return {
    status,
    event: params.event,
    phase: params.phase,
    results,
    finalPayload: currentPayload,
    validationSummary: summary,
    totalDurationMs: Date.now() - start,
    abortedAt: abortInfo,
  };
}

interface PhaseOutcome {
  status: InterceptorChainStatus;
  abort?: ChainAbortInfo;
}

interface MutationsOutcome extends PhaseOutcome {
  payload: unknown;
}

async function runMutations(
  mutations: McpInterceptor[],
  params: ExecuteChainRequestParams,
  initialPayload: unknown,
  results: InterceptorResult[],
  signal: AbortSignal | undefined,
): Promise<MutationsOutcome> {
  let payload = initialPayload;
  for (const interceptor of mutations) {
    try {
      const t0 = Date.now();
      const result = await interceptor.invoke({
        payload,
        config: extractConfig(params, interceptor.metadata.name),
        event: params.event,
        phase: params.phase,
        context: params.context,
        signal,
      });
      const stamped = stamp(result, interceptor.metadata.name, params.phase, t0);
      results.push(stamped);
      if (stamped.type === 'mutation') {
        const m = stamped;
        if (m.modified && m.payload !== undefined) {
          payload = m.payload;
        }
      }
    } catch (err) {
      return {
        payload,
        status: 'mutation_failed',
        abort: {
          interceptor: interceptor.metadata.name,
          reason: err instanceof Error ? err.message : String(err),
          type: 'mutation',
        },
      };
    }
  }
  return { payload, status: 'success' };
}

async function runValidations(
  validations: McpInterceptor[],
  params: ExecuteChainRequestParams,
  payload: unknown,
  results: InterceptorResult[],
  summary: ChainValidationSummary,
  signal: AbortSignal | undefined,
): Promise<PhaseOutcome> {
  const settled = await Promise.all(
    validations.map(async (interceptor) => {
      const t0 = Date.now();
      const result = await interceptor.invoke({
        payload,
        config: extractConfig(params, interceptor.metadata.name),
        event: params.event,
        phase: params.phase,
        context: params.context,
        signal,
      });
      return {
        interceptor,
        result: stamp(result, interceptor.metadata.name, params.phase, t0),
      };
    }),
  );

  let outcome: PhaseOutcome = { status: 'success' };
  for (const { interceptor, result } of settled) {
    results.push(result);
    if (result.type === 'validation') {
      const v = result;
      if (v.messages) {
        for (const msg of v.messages) {
          if (msg.severity === 'error') summary.errors++;
          else if (msg.severity === 'warn') summary.warnings++;
          else summary.infos++;
        }
      }
      if (!v.valid && v.severity === 'error' && outcome.status === 'success') {
        outcome = {
          status: 'validation_failed',
          abort: {
            interceptor: interceptor.metadata.name,
            reason: v.messages?.[0]?.message ?? 'Validation failed',
            type: 'validation',
          },
        };
      }
    }
  }
  return outcome;
}

async function runObservability(
  observability: McpInterceptor[],
  params: ExecuteChainRequestParams,
  payload: unknown,
  results: InterceptorResult[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const settled = await Promise.all(
    observability.map(async (interceptor) => {
      try {
        const t0 = Date.now();
        const result = await interceptor.invoke({
          payload,
          config: extractConfig(params, interceptor.metadata.name),
          event: params.event,
          phase: params.phase,
          context: params.context,
          signal,
        });
        return stamp(result, interceptor.metadata.name, params.phase, t0);
      } catch {
        // Fire-and-forget: failures are swallowed and recorded as observed=false.
        return {
          ...ObservabilityResult.noop(),
          interceptor: interceptor.metadata.name,
          phase: params.phase,
        } satisfies InterceptorResult;
      }
    }),
  );
  results.push(...settled);
}

function filterInterceptors(
  interceptors: readonly McpInterceptor[],
  params: ExecuteChainRequestParams,
): McpInterceptor[] {
  const nameFilter = params.interceptors;
  return interceptors.filter((i) => {
    if (nameFilter && nameFilter.length > 0 && !nameFilter.includes(i.metadata.name)) {
      return false;
    }
    if (!matchesEvent(i.metadata.events, params.event)) return false;
    const phase = i.metadata.phase;
    if (phase !== 'both' && phase !== params.phase) return false;
    return true;
  });
}

function stamp(
  result: InterceptorResult,
  name: string,
  phase: InterceptorPhase,
  t0: number,
): InterceptorResult {
  return {
    ...result,
    interceptor: name,
    phase,
    durationMs: Date.now() - t0,
  };
}

/**
 * Extract per-interceptor config from the chain `config` object, if present.
 * The chain `config` is treated as a map keyed by interceptor name.
 */
function extractConfig(
  params: ExecuteChainRequestParams,
  name: string,
): unknown {
  const cfg = params.config;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    return (cfg as Record<string, unknown>)[name];
  }
  return undefined;
}

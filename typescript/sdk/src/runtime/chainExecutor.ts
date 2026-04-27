// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import {
  type ChainAbortInfo,
  type ChainExecutionParams,
  type ChainExecutionResult,
  type ChainValidationSummary,
  type Interceptor,
  type InterceptorChainStatus,
  type InterceptorMode,
  type InterceptorPhase,
  type InterceptorResult,
  resolvePriority,
} from '../protocol/index.js';
import { matchesEvent } from './eventMatching.js';
import type { McpInterceptor } from './interceptor.js';

/**
 * Executes a list of locally-defined interceptors per SEP-2624.
 *
 * Sending (request phase): mutations (sequential, ascending priority) →
 *   validations (parallel) → forward.
 * Receiving (response phase): receive → validations (parallel) → mutations
 *   (sequential).
 *
 * Audit-mode interceptors (`mode: 'audit'`) never block — their results are
 * recorded but they cannot abort the chain. Fail-open interceptors
 * (`failOpen: true`) survive throws and timeouts without aborting.
 *
 * Pure observers are expressed as audit-mode validators (`mode: 'audit'`,
 * `failOpen: true`) — they run in parallel like other validators but cannot
 * block and tolerate crashes.
 */
export async function executeChain(
  interceptors: readonly McpInterceptor[],
  params: ChainExecutionParams,
  signal?: AbortSignal,
): Promise<ChainExecutionResult> {
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
      const pa = resolvePriority(a.metadata.priorityHint, params.phase);
      const pb = resolvePriority(b.metadata.priorityHint, params.phase);
      if (pa !== pb) return pa - pb;
      return a.metadata.name < b.metadata.name ? -1 : 1;
    });
  const validations = applicable.filter((i) => i.metadata.type === 'validation');

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
        }
      }
    } else {
      // response phase
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
  params: ChainExecutionParams,
  initialPayload: unknown,
  results: InterceptorResult[],
  signal: AbortSignal | undefined,
): Promise<MutationsOutcome> {
  let payload = initialPayload;
  for (const interceptor of mutations) {
    const mode = effectiveMode(interceptor.metadata.mode);
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
      const stamped = stamp(result, interceptor.metadata, params.phase, t0);
      results.push(stamped);
      // Audit-mode mutations are SHADOW: result is recorded but the
      // transformation is not applied to the live payload.
      if (mode === 'active' && stamped.type === 'mutation') {
        const m = stamped;
        if (m.modified && m.payload !== undefined) {
          payload = m.payload;
        }
      }
    } catch (err) {
      // Audit-mode and fail-open mutations don't abort the chain.
      if (mode === 'audit' || interceptor.metadata.failOpen) {
        results.push({
          type: 'mutation',
          interceptor: interceptor.metadata.name,
          phase: params.phase,
          mode,
          modified: false,
          info: { error: err instanceof Error ? err.message : String(err) },
        });
        continue;
      }
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
  params: ChainExecutionParams,
  payload: unknown,
  results: InterceptorResult[],
  summary: ChainValidationSummary,
  signal: AbortSignal | undefined,
): Promise<PhaseOutcome> {
  const settled = await Promise.all(
    validations.map(async (interceptor) => {
      const mode = effectiveMode(interceptor.metadata.mode);
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
        return {
          interceptor,
          result: stamp(result, interceptor.metadata, params.phase, t0),
        };
      } catch (err) {
        // Audit-mode and fail-open validators record a synthetic result
        // rather than aborting.
        if (mode === 'audit' || interceptor.metadata.failOpen) {
          const synthetic: InterceptorResult = {
            type: 'validation',
            interceptor: interceptor.metadata.name,
            phase: params.phase,
            mode,
            valid: true,
            info: { error: err instanceof Error ? err.message : String(err) },
          };
          return { interceptor, result: synthetic };
        }
        throw err;
      }
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
      const mode = effectiveMode(interceptor.metadata.mode);
      // Audit-mode results are recorded but cannot abort the chain.
      if (
        mode === 'active' &&
        !v.valid &&
        v.severity === 'error' &&
        outcome.status === 'success'
      ) {
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

function filterInterceptors(
  interceptors: readonly McpInterceptor[],
  params: ChainExecutionParams,
): McpInterceptor[] {
  const nameFilter = params.interceptors;
  return interceptors.filter((i) => {
    if (
      nameFilter &&
      nameFilter.length > 0 &&
      !nameFilter.includes(i.metadata.name)
    ) {
      return false;
    }
    // Match if any hook entry covers this (event, phase) pair.
    return i.metadata.hooks.some(
      (h) => h.phase === params.phase && matchesEvent(h.events, params.event),
    );
  });
}

function effectiveMode(mode: InterceptorMode | undefined): InterceptorMode {
  return mode ?? 'active';
}

function stamp(
  result: InterceptorResult,
  meta: Interceptor,
  phase: InterceptorPhase,
  t0: number,
): InterceptorResult {
  return {
    ...result,
    interceptor: meta.name,
    phase,
    mode: effectiveMode(meta.mode),
    durationMs: Date.now() - t0,
  };
}

/**
 * Extract per-interceptor config from the chain `config` object, if present.
 * The chain `config` is treated as a map keyed by interceptor name.
 */
function extractConfig(params: ChainExecutionParams, name: string): unknown {
  const cfg = params.config;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    return (cfg as Record<string, unknown>)[name];
  }
  return undefined;
}

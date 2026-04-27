// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';

/**
 * Interceptor type. Determines result shape and chain execution semantics.
 *
 * - `validation`: pass/fail with severity, executes in parallel, error severity aborts the chain.
 * - `mutation`: transforms payloads, executes sequentially ordered by `priorityHint`.
 * - `observability`: fire-and-forget, parallel, failures swallowed.
 */
export const InterceptorTypeSchema = z.enum([
  'validation',
  'mutation',
  'observability',
]);
export type InterceptorType = z.infer<typeof InterceptorTypeSchema>;

/**
 * Phase in which an interceptor executes relative to the request/response lifecycle.
 *
 * - `request`: before the operation is forwarded to the backend.
 * - `response`: after the backend has produced a result.
 * - `both`: applies to both directions.
 */
export const InterceptorPhaseSchema = z.enum(['request', 'response', 'both']);
export type InterceptorPhase = z.infer<typeof InterceptorPhaseSchema>;

/**
 * Severity of a validation message.
 *
 * `error` aborts the interceptor chain; `warn` and `info` are non-blocking.
 */
export const ValidationSeveritySchema = z.enum(['info', 'warn', 'error']);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

/**
 * Overall status of an interceptor chain execution.
 */
export const InterceptorChainStatusSchema = z.enum([
  'success',
  'validation_failed',
  'mutation_failed',
  'timeout',
]);
export type InterceptorChainStatus = z.infer<typeof InterceptorChainStatusSchema>;

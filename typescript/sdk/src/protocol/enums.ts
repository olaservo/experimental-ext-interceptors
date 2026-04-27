// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';

/**
 * Interceptor type per SEP-2624 — only two types exist on the wire.
 *
 * - `validation`: pass/fail with severity, executes in parallel, error severity aborts the chain
 *   unless the interceptor is in audit mode.
 * - `mutation`: transforms payloads, executes sequentially ordered by `priorityHint`.
 *
 * Pure observers (logging/metrics) are expressed as audit-mode validators
 * (`type: 'validation'`, `mode: 'audit'`, `failOpen: true`).
 */
export const InterceptorTypeSchema = z.enum(['validation', 'mutation']);
export type InterceptorType = z.infer<typeof InterceptorTypeSchema>;

/**
 * Execution phase per SEP-2624. There is no `'both'` value — interceptors that
 * fire on both phases declare two `hooks[]` entries.
 */
export const InterceptorPhaseSchema = z.enum(['request', 'response']);
export type InterceptorPhase = z.infer<typeof InterceptorPhaseSchema>;

/**
 * Execution mode per SEP-2624.
 *
 * - `active` (default): normal blocking / transforming behavior
 * - `audit`: non-blocking. Validators log violations without blocking; mutations
 *   compute their transformations but do not apply them (shadow mutations).
 */
export const InterceptorModeSchema = z.enum(['active', 'audit']);
export type InterceptorMode = z.infer<typeof InterceptorModeSchema>;

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

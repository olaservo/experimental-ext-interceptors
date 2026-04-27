// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import {
  InterceptorModeSchema,
  InterceptorPhaseSchema,
  InterceptorTypeSchema,
} from './enums.js';

/**
 * Protocol version compatibility constraints for an interceptor.
 */
export const InterceptorCompatibilitySchema = z.object({
  minProtocol: z.string(),
  maxProtocol: z.string().optional(),
});
export type InterceptorCompatibility = z.infer<
  typeof InterceptorCompatibilitySchema
>;

/**
 * A `(events, phase)` entry inside an interceptor's `hooks` array. Per SEP-2624
 * an interceptor that fires on both phases declares two entries — one per phase.
 */
export const InterceptorHookSchema = z.object({
  events: z.array(z.string()),
  phase: InterceptorPhaseSchema,
});
export type InterceptorHook = z.infer<typeof InterceptorHookSchema>;

/**
 * Per-phase priority hint. Per SEP-2624 `priorityHint` may be a single number
 * (applies to both phases) or a per-phase object.
 */
export const InterceptorPriorityHintSchema = z.union([
  z.number().int(),
  z.object({
    request: z.number().int().optional(),
    response: z.number().int().optional(),
  }),
]);
export type InterceptorPriorityHint = z.infer<
  typeof InterceptorPriorityHintSchema
>;

/**
 * Resolve a `priorityHint` (single number or per-phase object) for a given phase.
 * Defaults to `0` when the field is undefined or the phase is unspecified.
 */
export function resolvePriority(
  hint: InterceptorPriorityHint | undefined,
  phase: 'request' | 'response',
): number {
  if (hint === undefined) return 0;
  if (typeof hint === 'number') return hint;
  return hint[phase] ?? 0;
}

/**
 * Protocol-level metadata describing an interceptor. Returned by `interceptors/list`.
 *
 * Mirrors the SEP-2624 `Interceptor` interface.
 */
export const InterceptorSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  type: InterceptorTypeSchema,
  hooks: z.array(InterceptorHookSchema),
  /**
   * Execution mode. Defaults to `'active'` when omitted. `'audit'` makes the
   * interceptor non-blocking regardless of result.
   */
  mode: InterceptorModeSchema.optional(),
  /**
   * Failure routing policy. Defaults to `false` (fail-closed: a thrown or
   * timed-out interceptor blocks the message). `true` (fail-open) lets the
   * message proceed past a failed interceptor.
   */
  failOpen: z.boolean().optional(),
  priorityHint: InterceptorPriorityHintSchema.optional(),
  compat: InterceptorCompatibilitySchema.optional(),
  configSchema: z.unknown().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type Interceptor = z.infer<typeof InterceptorSchema>;

/**
 * Capability advertised by an interceptor server. Placed under
 * `ServerCapabilities.experimental[INTERCEPTOR_CAPABILITY_KEY]` (singular per
 * SEP-2624). The TS SDK's `ServerCapabilities` schema strips unknown top-level
 * fields, so the SEP's top-level `capabilities.interceptor` is nested under
 * `experimental` while the SDK matures.
 */
export const InterceptorsCapabilitySchema = z.object({
  supportedEvents: z.array(z.string()),
});
export type InterceptorsCapability = z.infer<typeof InterceptorsCapabilitySchema>;

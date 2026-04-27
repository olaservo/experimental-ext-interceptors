// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import { InterceptorPhaseSchema } from './enums.js';
import { InterceptorSchema } from './interceptor.js';

/**
 * Identity of the principal associated with an interceptor invocation.
 */
export const InterceptorPrincipalSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  claims: z.record(z.string(), z.unknown()).optional(),
});
export type InterceptorPrincipal = z.infer<typeof InterceptorPrincipalSchema>;

/**
 * Context attached to an interceptor invocation: principal, tracing, session.
 */
export const InvokeInterceptorContextSchema = z.object({
  principal: InterceptorPrincipalSchema.optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
});
export type InvokeInterceptorContext = z.infer<
  typeof InvokeInterceptorContextSchema
>;

/**
 * Parameters for the `interceptors/list` request.
 */
export const ListInterceptorsRequestParamsSchema = z.object({
  cursor: z.string().optional(),
  event: z.string().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type ListInterceptorsRequestParams = z.infer<
  typeof ListInterceptorsRequestParamsSchema
>;

/**
 * Result of the `interceptors/list` request.
 */
export const ListInterceptorsResultSchema = z.object({
  interceptors: z.array(InterceptorSchema),
  nextCursor: z.string().optional(),
});
export type ListInterceptorsResult = z.infer<typeof ListInterceptorsResultSchema>;

/**
 * Parameters for the `interceptor/invoke` request.
 */
export const InvokeInterceptorRequestParamsSchema = z.object({
  name: z.string(),
  event: z.string(),
  phase: InterceptorPhaseSchema,
  payload: z.unknown(),
  config: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
  context: InvokeInterceptorContextSchema.optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type InvokeInterceptorRequestParams = z.infer<
  typeof InvokeInterceptorRequestParamsSchema
>;

/**
 * Parameters to the SDK-side chain execution helper. SEP-2624 defines this as
 * `ChainExecutionParams` for the convenience utility — it is **not** a wire
 * method (chain execution is local; remote interceptors are reached via
 * repeated `interceptor/invoke` calls).
 */
export const ChainExecutionParamsSchema = z.object({
  event: z.string(),
  phase: InterceptorPhaseSchema,
  payload: z.unknown(),
  /** Optional list of specific interceptor names to include in the chain. */
  interceptors: z.array(z.string()).optional(),
  config: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
  context: InvokeInterceptorContextSchema.optional(),
});
export type ChainExecutionParams = z.infer<typeof ChainExecutionParamsSchema>;

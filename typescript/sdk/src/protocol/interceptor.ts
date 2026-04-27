// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import { InterceptorPhaseSchema, InterceptorTypeSchema } from './enums.js';

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
 * Protocol-level metadata describing an interceptor. Returned by `interceptors/list`.
 *
 * Mirrors the C# `Interceptor` POCO (`Protocol/Interceptor.cs`).
 */
export const InterceptorSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  events: z.array(z.string()),
  type: InterceptorTypeSchema,
  phase: InterceptorPhaseSchema,
  priorityHint: z.number().int().optional(),
  compat: InterceptorCompatibilitySchema.optional(),
  configSchema: z.unknown().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type Interceptor = z.infer<typeof InterceptorSchema>;

/**
 * Capability advertised by an interceptor server, placed under
 * `ServerCapabilities.experimental[INTERCEPTOR_CAPABILITY_KEY]`.
 *
 * Mirrors C# `InterceptorsCapability` (placed under `Extensions["interceptors"]`).
 */
export const InterceptorsCapabilitySchema = z.object({
  supportedEvents: z.array(z.string()),
});
export type InterceptorsCapability = z.infer<typeof InterceptorsCapabilitySchema>;

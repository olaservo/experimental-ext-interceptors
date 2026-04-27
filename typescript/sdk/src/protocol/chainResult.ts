// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import {
  InterceptorChainStatusSchema,
  InterceptorPhaseSchema,
} from './enums.js';
import { InterceptorResultSchema } from './interceptorResult.js';
import {
  ChainAbortInfoSchema,
  ChainValidationSummarySchema,
} from './validation.js';

/**
 * Result of an `interceptor/executeChain` request.
 *
 * Mirrors C# `InterceptorChainResult`.
 */
export const InterceptorChainResultSchema = z.object({
  status: InterceptorChainStatusSchema,
  event: z.string().optional(),
  phase: InterceptorPhaseSchema,
  results: z.array(InterceptorResultSchema),
  finalPayload: z.unknown().optional(),
  validationSummary: ChainValidationSummarySchema.optional(),
  totalDurationMs: z.number().int().nonnegative(),
  abortedAt: ChainAbortInfoSchema.optional(),
});
export type InterceptorChainResult = z.infer<typeof InterceptorChainResultSchema>;

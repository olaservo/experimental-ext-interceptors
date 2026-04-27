// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import {
  ExecuteChainRequestParamsSchema,
  InterceptorRequestMethods,
  InvokeInterceptorRequestParamsSchema,
  ListInterceptorsRequestParamsSchema,
} from '../protocol/index.js';

/**
 * Zod request schemas in the shape `setRequestHandler` expects: `{ method, params }`.
 */
export const ListInterceptorsRequestSchema = z.object({
  method: z.literal(InterceptorRequestMethods.InterceptorsList),
  params: ListInterceptorsRequestParamsSchema.optional(),
});

export const InvokeInterceptorRequestSchema = z.object({
  method: z.literal(InterceptorRequestMethods.InterceptorInvoke),
  params: InvokeInterceptorRequestParamsSchema,
});

export const ExecuteChainRequestSchema = z.object({
  method: z.literal(InterceptorRequestMethods.InterceptorExecuteChain),
  params: ExecuteChainRequestParamsSchema,
});

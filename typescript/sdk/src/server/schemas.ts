// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import {
  InterceptorRequestMethods,
  InvokeInterceptorRequestParamsSchema,
  ListInterceptorsRequestParamsSchema,
} from '../protocol/index.js';

/**
 * Zod request schemas in the shape `setRequestHandler` expects: `{ method, params }`.
 *
 * SEP-2624 defines exactly two wire methods: `interceptors/list` and
 * `interceptor/invoke`. Chain execution is an SDK-side helper that loops over
 * `interceptor/invoke` — there is no `interceptor/executeChain` wire method.
 */
export const ListInterceptorsRequestSchema = z.object({
  method: z.literal(InterceptorRequestMethods.InterceptorsList),
  params: ListInterceptorsRequestParamsSchema.optional(),
});

export const InvokeInterceptorRequestSchema = z.object({
  method: z.literal(InterceptorRequestMethods.InterceptorInvoke),
  params: InvokeInterceptorRequestParamsSchema,
});

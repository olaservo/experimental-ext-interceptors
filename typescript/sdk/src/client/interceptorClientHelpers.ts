// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ExecuteChainRequestParamsSchema,
  InterceptorChainResultSchema,
  InterceptorRequestMethods,
  InterceptorResultSchema,
  InvokeInterceptorRequestParamsSchema,
  ListInterceptorsRequestParamsSchema,
  ListInterceptorsResultSchema,
  type ExecuteChainRequestParams,
  type InterceptorChainResult,
  type InterceptorResult,
  type InvokeInterceptorRequestParams,
  type ListInterceptorsRequestParams,
  type ListInterceptorsResult,
} from '../protocol/index.js';

/**
 * Calls `interceptors/list` on the connected interceptor server.
 */
export async function listInterceptors(
  client: Client,
  params?: ListInterceptorsRequestParams,
): Promise<ListInterceptorsResult> {
  const validated = params ? ListInterceptorsRequestParamsSchema.parse(params) : {};
  return client.request(
    {
      method: InterceptorRequestMethods.InterceptorsList,
      params: validated,
    },
    ListInterceptorsResultSchema,
  );
}

/**
 * Calls `interceptor/invoke` on the connected interceptor server.
 */
export async function invokeInterceptor(
  client: Client,
  params: InvokeInterceptorRequestParams,
): Promise<InterceptorResult> {
  const validated = InvokeInterceptorRequestParamsSchema.parse(params);
  return client.request(
    {
      method: InterceptorRequestMethods.InterceptorInvoke,
      params: validated,
    },
    InterceptorResultSchema,
  );
}

/**
 * Calls `interceptor/executeChain` on the connected interceptor server.
 */
export async function executeInterceptorChain(
  client: Client,
  params: ExecuteChainRequestParams,
): Promise<InterceptorChainResult> {
  const validated = ExecuteChainRequestParamsSchema.parse(params);
  return client.request(
    {
      method: InterceptorRequestMethods.InterceptorExecuteChain,
      params: validated,
    },
    InterceptorChainResultSchema,
  );
}

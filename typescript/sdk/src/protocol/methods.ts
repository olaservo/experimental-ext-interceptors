// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

/**
 * JSON-RPC method names defined by the MCP interceptors extension (SEP-1763).
 */
export const InterceptorRequestMethods = {
  InterceptorsList: 'interceptors/list',
  InterceptorInvoke: 'interceptor/invoke',
  InterceptorExecuteChain: 'interceptor/executeChain',
} as const;

export type InterceptorRequestMethod =
  (typeof InterceptorRequestMethods)[keyof typeof InterceptorRequestMethods];

/**
 * The capability key under which the interceptors capability is advertised
 * in `ServerCapabilities` (typically nested under `experimental` in the TS SDK,
 * which mirrors the C# SDK's `ServerCapabilities.Extensions["interceptors"]`).
 */
export const INTERCEPTOR_CAPABILITY_KEY = 'interceptors';

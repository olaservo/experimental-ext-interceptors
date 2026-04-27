// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

/**
 * JSON-RPC method names defined by SEP-2624. Only two methods cross the wire;
 * chain execution is an SDK-side convenience that loops over `interceptor/invoke`.
 */
export const InterceptorRequestMethods = {
  InterceptorsList: 'interceptors/list',
  InterceptorInvoke: 'interceptor/invoke',
} as const;

export type InterceptorRequestMethod =
  (typeof InterceptorRequestMethods)[keyof typeof InterceptorRequestMethods];

/**
 * Capability key under which the interceptor extension is advertised. SEP-2624
 * places it at top-level (`capabilities.interceptor`, singular). The TS MCP
 * SDK's `ServerCapabilities` schema strips unknown top-level fields, so we
 * nest under `experimental` while preserving the singular SEP key.
 */
export const INTERCEPTOR_CAPABILITY_KEY = 'interceptor';

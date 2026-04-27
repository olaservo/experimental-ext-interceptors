// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { InterceptorEvents } from '../protocol/index.js';

/**
 * Returns true when an interceptor declaring `interceptorEvents` matches the
 * incoming `requestEvent`.
 *
 * Mirrors the C# `InterceptorChainExecutor.MatchesEvent` semantics:
 * - `*` matches any event
 * - exact match by event name
 * - `*\/request` and `*\/response` match events that look "phase-tagged"
 *   (the C# port uses a heuristic against the `/` separator; we replicate that
 *   to stay wire-compatible until the SEP nails wildcards down)
 */
export function matchesEvent(
  interceptorEvents: readonly string[],
  requestEvent: string,
): boolean {
  for (const ev of interceptorEvents) {
    if (ev === InterceptorEvents.All) return true;
    if (ev === requestEvent) return true;
    if (
      (ev === InterceptorEvents.AllRequests ||
        ev === InterceptorEvents.AllResponses) &&
      !requestEvent.includes('/')
    ) {
      return true;
    }
  }
  return false;
}

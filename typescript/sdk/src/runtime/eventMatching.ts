// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { InterceptorEvents } from '../protocol/index.js';

/**
 * Returns true when an interceptor's hook events match the incoming event.
 *
 * SEP-2624 only requires that the literal `'*'` matches every event.
 * Implementations MAY support namespace wildcards (e.g. `'tools/*'`); this
 * implementation supports the trailing-`/*` form.
 */
export function matchesEvent(
  hookEvents: readonly string[],
  requestEvent: string,
): boolean {
  for (const ev of hookEvents) {
    if (ev === InterceptorEvents.All) return true;
    if (ev === requestEvent) return true;
    if (ev.endsWith('/*')) {
      const prefix = ev.slice(0, -1); // keep the trailing '/'
      if (requestEvent.startsWith(prefix)) return true;
    }
  }
  return false;
}

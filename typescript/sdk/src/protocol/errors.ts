// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { InterceptorChainResult } from './chainResult.js';
import type { ValidationMessage } from './validation.js';

/**
 * Thrown when an interceptor validation fails with `error` severity, aborting the chain.
 */
export class McpInterceptorValidationError extends Error {
  readonly chainResult?: InterceptorChainResult;
  readonly validationMessages: readonly ValidationMessage[];

  constructor(
    message: string,
    options?: {
      validationMessages?: readonly ValidationMessage[];
      chainResult?: InterceptorChainResult;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'McpInterceptorValidationError';
    this.validationMessages = options?.validationMessages ?? [];
    this.chainResult = options?.chainResult;
  }
}

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { describe, expect, it } from 'vitest';
import {
  InterceptorChainResultSchema,
  InterceptorResultSchema,
  ListInterceptorsResultSchema,
  MutationResult,
  ObservabilityResult,
  ValidationResult,
} from './index.js';

describe('InterceptorResult discriminated union', () => {
  it('round-trips a validation result via JSON', () => {
    const r = ValidationResult.error('bad', '$.x');
    const wire = JSON.parse(JSON.stringify(r)) as unknown;
    const parsed = InterceptorResultSchema.parse(wire);
    expect(parsed.type).toBe('validation');
    if (parsed.type !== 'validation') return;
    expect(parsed.valid).toBe(false);
    expect(parsed.severity).toBe('error');
    expect(parsed.messages?.[0]?.path).toBe('$.x');
  });

  it('round-trips a mutation result via JSON', () => {
    const r = MutationResult.mutated({ hello: 'world' });
    const wire = JSON.parse(JSON.stringify(r)) as unknown;
    const parsed = InterceptorResultSchema.parse(wire);
    expect(parsed.type).toBe('mutation');
    if (parsed.type !== 'mutation') return;
    expect(parsed.modified).toBe(true);
    expect(parsed.payload).toEqual({ hello: 'world' });
  });

  it('round-trips an observability result via JSON', () => {
    const r = ObservabilityResult.success({ bytes: 42 });
    const wire = JSON.parse(JSON.stringify(r)) as unknown;
    const parsed = InterceptorResultSchema.parse(wire);
    expect(parsed.type).toBe('observability');
    if (parsed.type !== 'observability') return;
    expect(parsed.observed).toBe(true);
    expect(parsed.metrics?.bytes).toBe(42);
  });

  it('rejects an unknown discriminator', () => {
    expect(() =>
      InterceptorResultSchema.parse({ type: 'bogus', whatever: 1 }),
    ).toThrow();
  });
});

describe('Chain result and list result schemas', () => {
  it('parses a minimal InterceptorChainResult', () => {
    const parsed = InterceptorChainResultSchema.parse({
      status: 'success',
      phase: 'request',
      results: [],
      totalDurationMs: 0,
    });
    expect(parsed.status).toBe('success');
  });

  it('parses a ListInterceptorsResult shape', () => {
    const parsed = ListInterceptorsResultSchema.parse({
      interceptors: [
        {
          name: 'x',
          events: ['tools/call'],
          type: 'validation',
          phase: 'request',
        },
      ],
    });
    expect(parsed.interceptors[0].name).toBe('x');
  });
});

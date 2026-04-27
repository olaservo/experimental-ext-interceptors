// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { describe, expect, it } from 'vitest';
import {
  ChainExecutionResultSchema,
  InterceptorResultSchema,
  ListInterceptorsResultSchema,
  MutationResult,
  ValidationResult,
  resolvePriority,
} from './index.js';

describe('InterceptorResult discriminated union (SEP-2624: 2 types)', () => {
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

  it('rejects an unknown discriminator (no observability)', () => {
    expect(() =>
      InterceptorResultSchema.parse({ type: 'observability', observed: true }),
    ).toThrow();
    expect(() =>
      InterceptorResultSchema.parse({ type: 'bogus', whatever: 1 }),
    ).toThrow();
  });
});

describe('Chain result and list result schemas', () => {
  it('parses a minimal ChainExecutionResult', () => {
    const parsed = ChainExecutionResultSchema.parse({
      status: 'success',
      phase: 'request',
      results: [],
      totalDurationMs: 0,
    });
    expect(parsed.status).toBe('success');
  });

  it('parses a ListInterceptorsResult with the SEP-2624 hooks shape', () => {
    const parsed = ListInterceptorsResultSchema.parse({
      interceptors: [
        {
          name: 'x',
          type: 'validation',
          hooks: [{ events: ['tools/call'], phase: 'request' }],
        },
      ],
    });
    expect(parsed.interceptors[0].name).toBe('x');
    expect(parsed.interceptors[0].hooks[0].phase).toBe('request');
  });

  it('parses an interceptor with mode, failOpen, and per-phase priorityHint', () => {
    const parsed = ListInterceptorsResultSchema.parse({
      interceptors: [
        {
          name: 'audit-logger',
          type: 'validation',
          mode: 'audit',
          failOpen: true,
          hooks: [
            { events: ['*'], phase: 'request' },
            { events: ['*'], phase: 'response' },
          ],
        },
        {
          name: 'pii-redactor',
          type: 'mutation',
          hooks: [{ events: ['tools/call'], phase: 'request' }],
          priorityHint: { request: -1000, response: 1000 },
        },
      ],
    });
    expect(parsed.interceptors[0].mode).toBe('audit');
    expect(parsed.interceptors[0].failOpen).toBe(true);
    expect(parsed.interceptors[1].priorityHint).toEqual({
      request: -1000,
      response: 1000,
    });
  });
});

describe('resolvePriority', () => {
  it('returns 0 when undefined', () => {
    expect(resolvePriority(undefined, 'request')).toBe(0);
  });

  it('returns the same number for both phases when given a number', () => {
    expect(resolvePriority(-500, 'request')).toBe(-500);
    expect(resolvePriority(-500, 'response')).toBe(-500);
  });

  it('returns the per-phase value when given an object', () => {
    expect(resolvePriority({ request: -1000, response: 500 }, 'request')).toBe(
      -1000,
    );
    expect(resolvePriority({ request: -1000, response: 500 }, 'response')).toBe(
      500,
    );
  });

  it('falls back to 0 when the per-phase entry is missing', () => {
    expect(resolvePriority({ request: -1000 }, 'response')).toBe(0);
  });
});

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { describe, expect, it } from 'vitest';
import {
  InterceptorEvents,
  MutationResult,
  ObservabilityResult,
  ValidationResult,
  type InterceptorResult,
  type InterceptorType,
  type InterceptorPhase,
} from '../protocol/index.js';
import {
  defineInterceptor,
  type InterceptorInvocationContext,
} from '../server/defineInterceptor.js';
import { executeChain } from './chainExecutor.js';

interface FakeOpts {
  name: string;
  type: InterceptorType;
  events?: string[];
  phase?: InterceptorPhase;
  priorityHint?: number;
  invoke: (
    ctx: InterceptorInvocationContext,
  ) => InterceptorResult | Promise<InterceptorResult>;
}

function fake(opts: FakeOpts) {
  return defineInterceptor({
    name: opts.name,
    type: opts.type,
    events: opts.events ?? [InterceptorEvents.All],
    phase: opts.phase ?? 'both',
    priorityHint: opts.priorityHint,
    invoke: opts.invoke,
  });
}

describe('executeChain — request phase ordering', () => {
  it('runs mutations before validations before observability', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return {
          type: 'mutation',
          modified: true,
          payload: { mutated: true },
        };
      },
    });
    const val = fake({
      name: 'val',
      type: 'validation',
      invoke: () => {
        order.push('validation');
        return ValidationResult.success();
      },
    });
    const obs = fake({
      name: 'obs',
      type: 'observability',
      invoke: () => {
        order.push('observability');
        return ObservabilityResult.success();
      },
    });

    const result = await executeChain([mut, val, obs], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: { original: true },
    });

    expect(result.status).toBe('success');
    expect(order).toEqual(['mutation', 'validation', 'observability']);
    expect(result.finalPayload).toEqual({ mutated: true });
  });

  it('runs mutations sequentially in ascending priority order', async () => {
    const order: string[] = [];
    const high = fake({
      name: 'mut-high',
      type: 'mutation',
      priorityHint: 100,
      invoke: () => {
        order.push('high');
        return { type: 'mutation', modified: false };
      },
    });
    const low = fake({
      name: 'mut-low',
      type: 'mutation',
      priorityHint: -100,
      invoke: () => {
        order.push('low');
        return { type: 'mutation', modified: false };
      },
    });
    const def = fake({
      name: 'mut-default',
      type: 'mutation',
      priorityHint: 0,
      invoke: () => {
        order.push('default');
        return { type: 'mutation', modified: false };
      },
    });

    const result = await executeChain([high, low, def], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });

    expect(result.status).toBe('success');
    expect(order).toEqual(['low', 'default', 'high']);
  });

  it('breaks priority ties alphabetically by name', async () => {
    const order: string[] = [];
    const make = (name: string) =>
      fake({
        name,
        type: 'mutation',
        priorityHint: 0,
        invoke: () => {
          order.push(name);
          return { type: 'mutation', modified: false };
        },
      });

    const result = await executeChain(
      [make('zebra'), make('alpha'), make('beta')],
      {
        event: InterceptorEvents.ToolsCall,
        phase: 'request',
        payload: {},
      },
    );
    expect(result.status).toBe('success');
    expect(order).toEqual(['alpha', 'beta', 'zebra']);
  });

  it('chains payloads through sequential mutations', async () => {
    const a = fake({
      name: 'a',
      type: 'mutation',
      priorityHint: 0,
      invoke: ({ payload }) =>
        MutationResult.mutated({ ...(payload as object), step1: true }),
    });
    const b = fake({
      name: 'b',
      type: 'mutation',
      priorityHint: 1,
      invoke: ({ payload }) => {
        // We get a's mutated output here.
        expect((payload as { step1: boolean }).step1).toBe(true);
        return MutationResult.mutated({
          ...(payload as object),
          step2: true,
        });
      },
    });

    const result = await executeChain([a, b], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: { original: true },
    });
    expect(result.status).toBe('success');
    expect(result.finalPayload).toEqual({
      original: true,
      step1: true,
      step2: true,
    });
  });
});

describe('executeChain — response phase ordering', () => {
  it('runs validations before observability before mutations', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return { type: 'mutation', modified: false };
      },
    });
    const val = fake({
      name: 'val',
      type: 'validation',
      invoke: () => {
        order.push('validation');
        return ValidationResult.success();
      },
    });
    const obs = fake({
      name: 'obs',
      type: 'observability',
      invoke: () => {
        order.push('observability');
        return ObservabilityResult.success();
      },
    });

    const result = await executeChain([mut, val, obs], {
      event: InterceptorEvents.ToolsCall,
      phase: 'response',
      payload: {},
    });

    expect(result.status).toBe('success');
    expect(order).toEqual(['validation', 'observability', 'mutation']);
  });

  it('blocks mutations when a response-phase validator errors', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return { type: 'mutation', modified: false };
      },
    });
    const val = fake({
      name: 'val',
      type: 'validation',
      invoke: () => ValidationResult.error('nope'),
    });

    const result = await executeChain([mut, val], {
      event: InterceptorEvents.ResourcesRead,
      phase: 'response',
      payload: {},
    });

    expect(result.status).toBe('validation_failed');
    expect(order).toEqual([]); // mutation never ran
    expect(result.abortedAt?.interceptor).toBe('val');
    expect(result.abortedAt?.type).toBe('validation');
  });
});

describe('executeChain — abort and summary', () => {
  it('aborts the chain on validation error', async () => {
    const val = fake({
      name: 'strict',
      type: 'validation',
      invoke: () =>
        ValidationResult.failure({
          message: 'Required field missing',
          severity: 'error',
        }),
    });
    const result = await executeChain([val], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('validation_failed');
    expect(result.abortedAt?.interceptor).toBe('strict');
    expect(result.abortedAt?.type).toBe('validation');
  });

  it('swallows observability failures', async () => {
    const obs = fake({
      name: 'failing-obs',
      type: 'observability',
      invoke: () => {
        throw new Error('boom');
      },
    });
    const result = await executeChain([obs], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe('observability');
    expect(
      (result.results[0] as { observed: boolean }).observed,
    ).toBe(false);
  });

  it('counts validation messages by severity', async () => {
    const val = fake({
      name: 'val',
      type: 'validation',
      invoke: () => ({
        type: 'validation',
        valid: true,
        messages: [
          { message: 'i', severity: 'info' },
          { message: 'w1', severity: 'warn' },
          { message: 'w2', severity: 'warn' },
        ],
      }),
    });
    const result = await executeChain([val], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.validationSummary).toEqual({
      errors: 0,
      warnings: 2,
      infos: 1,
    });
  });
});

describe('executeChain — filtering', () => {
  it('filters interceptors by event', async () => {
    const tools = fake({
      name: 'tools-only',
      type: 'validation',
      events: [InterceptorEvents.ToolsCall],
      invoke: () => ValidationResult.success(),
    });
    const prompts = fake({
      name: 'prompts-only',
      type: 'validation',
      events: [InterceptorEvents.PromptsGet],
      invoke: () => ValidationResult.success(),
    });
    const result = await executeChain([tools, prompts], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].interceptor).toBe('tools-only');
  });

  it('filters interceptors by phase', async () => {
    const reqOnly = fake({
      name: 'request-only',
      type: 'validation',
      phase: 'request',
      invoke: () => ValidationResult.success(),
    });
    const respOnly = fake({
      name: 'response-only',
      type: 'validation',
      phase: 'response',
      invoke: () => ValidationResult.success(),
    });
    const result = await executeChain([reqOnly, respOnly], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].interceptor).toBe('request-only');
  });
});

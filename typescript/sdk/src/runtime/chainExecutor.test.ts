// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import { describe, expect, it } from 'vitest';
import {
  InterceptorEvents,
  MutationResult,
  ValidationResult,
  type InterceptorHook,
  type InterceptorMode,
  type InterceptorPhase,
  type InterceptorPriorityHint,
  type InterceptorResult,
  type InterceptorType,
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
  hooks?: InterceptorHook[];
  priorityHint?: InterceptorPriorityHint;
  mode?: InterceptorMode;
  failOpen?: boolean;
  invoke: (
    ctx: InterceptorInvocationContext,
  ) => InterceptorResult | Promise<InterceptorResult>;
}

function fake(opts: FakeOpts) {
  return defineInterceptor({
    name: opts.name,
    type: opts.type,
    hooks:
      opts.hooks ??
      (opts.phase
        ? [{ events: opts.events ?? [InterceptorEvents.All], phase: opts.phase }]
        : [
            { events: opts.events ?? [InterceptorEvents.All], phase: 'request' },
            { events: opts.events ?? [InterceptorEvents.All], phase: 'response' },
          ]),
    priorityHint: opts.priorityHint,
    mode: opts.mode,
    failOpen: opts.failOpen,
    invoke: opts.invoke,
  });
}

describe('executeChain — request phase ordering', () => {
  it('runs mutations before validations', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return MutationResult.mutated({ mutated: true });
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

    const result = await executeChain([mut, val], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: { original: true },
    });

    expect(result.status).toBe('success');
    expect(order).toEqual(['mutation', 'validation']);
    expect(result.finalPayload).toEqual({ mutated: true });
  });

  it('runs mutations sequentially in ascending priority order', async () => {
    const order: string[] = [];
    const make = (name: string, priority: number) =>
      fake({
        name,
        type: 'mutation',
        priorityHint: priority,
        invoke: () => {
          order.push(name);
          return MutationResult.unchanged({});
        },
      });
    const result = await executeChain(
      [make('mut-high', 100), make('mut-low', -100), make('mut-default', 0)],
      {
        event: InterceptorEvents.ToolsCall,
        phase: 'request',
        payload: {},
      },
    );
    expect(result.status).toBe('success');
    expect(order).toEqual(['mut-low', 'mut-default', 'mut-high']);
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
          return MutationResult.unchanged({});
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
        expect((payload as { step1: boolean }).step1).toBe(true);
        return MutationResult.mutated({ ...(payload as object), step2: true });
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

  it('respects per-phase priorityHint object', async () => {
    const order: string[] = [];
    const a = fake({
      name: 'a',
      type: 'mutation',
      priorityHint: { request: 100, response: -100 },
      invoke: () => {
        order.push('a');
        return MutationResult.unchanged({});
      },
    });
    const b = fake({
      name: 'b',
      type: 'mutation',
      priorityHint: { request: -100, response: 100 },
      invoke: () => {
        order.push('b');
        return MutationResult.unchanged({});
      },
    });

    await executeChain([a, b], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(order).toEqual(['b', 'a']); // b has lower request priority

    order.length = 0;
    await executeChain([a, b], {
      event: InterceptorEvents.ToolsCall,
      phase: 'response',
      payload: {},
    });
    expect(order).toEqual(['a', 'b']); // a has lower response priority
  });
});

describe('executeChain — response phase ordering', () => {
  it('runs validations before mutations', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return MutationResult.unchanged({});
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
    const result = await executeChain([mut, val], {
      event: InterceptorEvents.ToolsCall,
      phase: 'response',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(order).toEqual(['validation', 'mutation']);
  });

  it('blocks mutations when a response-phase validator errors', async () => {
    const order: string[] = [];
    const mut = fake({
      name: 'mut',
      type: 'mutation',
      invoke: () => {
        order.push('mutation');
        return MutationResult.unchanged({});
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
    expect(order).toEqual([]);
    expect(result.abortedAt?.interceptor).toBe('val');
    expect(result.abortedAt?.type).toBe('validation');
  });
});

describe('executeChain — abort, summary, audit, failOpen', () => {
  it('aborts the chain on validation error in active mode', async () => {
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
  });

  it('audit-mode validators NEVER block, even on error severity', async () => {
    const auditor = fake({
      name: 'audit-strict',
      type: 'validation',
      mode: 'audit',
      invoke: () => ValidationResult.error('would have blocked'),
    });
    const result = await executeChain([auditor], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(1);
    expect(result.validationSummary?.errors).toBe(1);
  });

  it('failOpen=true validators that throw do NOT abort the chain', async () => {
    const buggy = fake({
      name: 'buggy',
      type: 'validation',
      failOpen: true,
      invoke: () => {
        throw new Error('crash');
      },
    });
    const result = await executeChain([buggy], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    expect(result.status).toBe('success');
    expect(result.results[0].type).toBe('validation');
    expect(result.results[0].info?.error).toBe('crash');
  });

  it('failOpen=false validators that throw DO abort the chain', async () => {
    const buggy = fake({
      name: 'buggy-strict',
      type: 'validation',
      invoke: () => {
        throw new Error('crash');
      },
    });
    await expect(
      executeChain([buggy], {
        event: InterceptorEvents.ToolsCall,
        phase: 'request',
        payload: {},
      }),
    ).rejects.toThrow('crash');
  });

  it('audit-mode mutations are SHADOW (computed but not applied)', async () => {
    const shadow = fake({
      name: 'shadow',
      type: 'mutation',
      mode: 'audit',
      invoke: () => MutationResult.mutated({ would: 'be' }),
    });
    const result = await executeChain([shadow], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: { original: true },
    });
    expect(result.status).toBe('success');
    expect(result.finalPayload).toEqual({ original: true });
    expect(result.results[0].mode).toBe('audit');
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

describe('executeChain — filtering by hooks', () => {
  it('filters interceptors by event', async () => {
    const tools = fake({
      name: 'tools-only',
      type: 'validation',
      events: [InterceptorEvents.ToolsCall],
      phase: 'request',
      invoke: () => ValidationResult.success(),
    });
    const prompts = fake({
      name: 'prompts-only',
      type: 'validation',
      events: [InterceptorEvents.PromptsGet],
      phase: 'request',
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

  it('matches an interceptor on either phase via two hook entries', async () => {
    const both = fake({
      name: 'both-phases',
      type: 'validation',
      hooks: [
        { events: [InterceptorEvents.ToolsCall], phase: 'request' },
        { events: [InterceptorEvents.ToolsCall], phase: 'response' },
      ],
      invoke: () => ValidationResult.success(),
    });
    const onReq = await executeChain([both], {
      event: InterceptorEvents.ToolsCall,
      phase: 'request',
      payload: {},
    });
    const onResp = await executeChain([both], {
      event: InterceptorEvents.ToolsCall,
      phase: 'response',
      payload: {},
    });
    expect(onReq.results).toHaveLength(1);
    expect(onResp.results).toHaveLength(1);
  });

  it('matches namespace wildcards like tools/*', async () => {
    const toolsAny = fake({
      name: 'tools-namespace',
      type: 'validation',
      events: ['tools/*'],
      phase: 'request',
      invoke: () => ValidationResult.success(),
    });
    const result = await executeChain([toolsAny], {
      event: 'tools/call',
      phase: 'request',
      payload: {},
    });
    expect(result.results).toHaveLength(1);

    const noMatch = await executeChain([toolsAny], {
      event: 'prompts/get',
      phase: 'request',
      payload: {},
    });
    expect(noMatch.results).toHaveLength(0);
  });
});

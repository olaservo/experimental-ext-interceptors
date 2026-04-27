// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
  SubscribeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  InterceptorEvents,
  type InvokeInterceptorContext,
  type ListInterceptorsRequestParams,
  type ListInterceptorsResult,
} from '../protocol/index.js';
import { InterceptorChainRunner, throwChainFailure } from './chainRunner.js';
import { listInterceptors } from './interceptorClientHelpers.js';

export interface InterceptingClientOptions {
  /** Client connected to an interceptor server. Required. */
  interceptorClient: Client;
  /** Event types to intercept. When undefined or empty, all events are intercepted. */
  events?: readonly string[];
  /** Default timeout in milliseconds passed to each `interceptor/executeChain` call. */
  timeoutMs?: number;
  /** Default context (principal/trace/session) attached to chain executions. */
  defaultContext?: InvokeInterceptorContext;
}

/**
 * A gateway-style wrapper around a backend MCP `Client` that routes operations
 * through an interceptor server before forwarding to the backend.
 *
 * Mirrors C# `Client/InterceptingMcpClient.cs`. This is composition, not
 * inheritance — `inner` is the original `Client` the wrapper was constructed with.
 */
export class InterceptingClient {
  private readonly chainRunner: InterceptorChainRunner;

  constructor(
    public readonly inner: Client,
    private readonly options: InterceptingClientOptions,
  ) {
    if (!options.interceptorClient) {
      throw new Error('InterceptingClientOptions.interceptorClient is required');
    }
    this.chainRunner = new InterceptorChainRunner(
      [options.interceptorClient],
      options.events,
      options.timeoutMs,
      options.defaultContext,
    );
  }

  get interceptorClient(): Client {
    return this.options.interceptorClient;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  async callTool(params: CallToolRequest['params']): Promise<CallToolResult> {
    return this.intercept({
      event: InterceptorEvents.ToolsCall,
      requestPayload: params,
      forward: (mutated) =>
        this.inner.callTool(mutated as CallToolRequest['params']),
    }) as Promise<CallToolResult>;
  }

  async listTools(
    params?: ListToolsRequest['params'],
  ): Promise<ListToolsResult> {
    return this.intercept({
      event: InterceptorEvents.ToolsList,
      requestPayload: params ?? {},
      forward: (mutated) =>
        this.inner.listTools(
          (mutated as ListToolsRequest['params']) ?? undefined,
        ),
    }) as Promise<ListToolsResult>;
  }

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  async getPrompt(params: GetPromptRequest['params']): Promise<GetPromptResult> {
    return this.intercept({
      event: InterceptorEvents.PromptsGet,
      requestPayload: params,
      forward: (mutated) =>
        this.inner.getPrompt(mutated as GetPromptRequest['params']),
    }) as Promise<GetPromptResult>;
  }

  async listPrompts(
    params?: ListPromptsRequest['params'],
  ): Promise<ListPromptsResult> {
    return this.intercept({
      event: InterceptorEvents.PromptsList,
      requestPayload: params ?? {},
      forward: (mutated) =>
        this.inner.listPrompts(
          (mutated as ListPromptsRequest['params']) ?? undefined,
        ),
    }) as Promise<ListPromptsResult>;
  }

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  async readResource(
    params: ReadResourceRequest['params'],
  ): Promise<ReadResourceResult> {
    return this.intercept({
      event: InterceptorEvents.ResourcesRead,
      requestPayload: params,
      forward: (mutated) =>
        this.inner.readResource(mutated as ReadResourceRequest['params']),
    }) as Promise<ReadResourceResult>;
  }

  async listResources(
    params?: ListResourcesRequest['params'],
  ): Promise<ListResourcesResult> {
    return this.intercept({
      event: InterceptorEvents.ResourcesList,
      requestPayload: params ?? {},
      forward: (mutated) =>
        this.inner.listResources(
          (mutated as ListResourcesRequest['params']) ?? undefined,
        ),
    }) as Promise<ListResourcesResult>;
  }

  /**
   * Subscribes to a resource. Only the request phase is intercepted — there is no
   * response payload to mutate beyond the empty result.
   */
  async subscribeResource(
    params: SubscribeRequest['params'],
  ): Promise<unknown> {
    if (!this.chainRunner.shouldIntercept(InterceptorEvents.ResourcesSubscribe)) {
      return this.inner.subscribeResource(params);
    }
    const requestPhase = await this.chainRunner.runPhase({
      event: InterceptorEvents.ResourcesSubscribe,
      phase: 'request',
      payload: params,
    });
    if (requestPhase.status !== 'success') {
      throwChainFailure({
        operation: 'resources/subscribe',
        phase: 'request',
        status: requestPhase.status,
        chainResult: requestPhase.chainResult,
      });
    }
    return this.inner.subscribeResource(
      requestPhase.payload as SubscribeRequest['params'],
    );
  }

  // ---------------------------------------------------------------------------
  // Direct interceptor server passthrough
  // ---------------------------------------------------------------------------

  async listInterceptors(
    params?: ListInterceptorsRequestParams,
  ): Promise<ListInterceptorsResult> {
    return listInterceptors(this.options.interceptorClient, params);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async intercept(args: {
    event: string;
    requestPayload: unknown;
    forward: (mutatedPayload: unknown) => Promise<unknown>;
  }): Promise<unknown> {
    if (!this.chainRunner.shouldIntercept(args.event)) {
      return args.forward(args.requestPayload);
    }

    // Request phase
    const requestPhase = await this.chainRunner.runPhase({
      event: args.event,
      phase: 'request',
      payload: args.requestPayload,
    });
    if (requestPhase.status !== 'success') {
      throwChainFailure({
        operation: args.event,
        phase: 'request',
        status: requestPhase.status,
        chainResult: requestPhase.chainResult,
      });
    }

    const result = await args.forward(requestPhase.payload);

    // Response phase
    const responsePhase = await this.chainRunner.runPhase({
      event: args.event,
      phase: 'response',
      payload: result,
    });
    if (responsePhase.status !== 'success') {
      throwChainFailure({
        operation: args.event,
        phase: 'response',
        status: responsePhase.status,
        chainResult: responsePhase.chainResult,
      });
    }
    return responsePhase.payload;
  }
}

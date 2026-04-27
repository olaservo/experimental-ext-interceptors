// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type GetPromptResult,
  type Implementation,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import {
  INTERCEPTOR_CAPABILITY_KEY,
  InterceptorEvents,
  type InvokeInterceptorContext,
} from '../protocol/index.js';
import {
  InterceptorChainRunner,
  throwChainFailure,
} from '../client/chainRunner.js';
import {
  InvokeInterceptorRequestSchema,
  ListInterceptorsRequestSchema,
} from '../server/schemas.js';
import {
  invokeInterceptor,
  listInterceptors,
} from '../client/interceptorClientHelpers.js';

export interface McpInterceptorGatewayOptions {
  /** Backend MCP server client. Required. */
  backendClient: Client;
  /**
   * Connected interceptor server clients, executed in order. Each client's
   * `interceptor/executeChain` receives the previous client's mutated payload.
   */
  interceptorClients: readonly Client[];
  /** Event types to intercept. When undefined or empty, all events are intercepted. */
  events?: readonly string[];
  /** Default timeout for interceptor chain execution (ms). */
  timeoutMs?: number;
  /** Default context attached to interceptor invocations. */
  defaultContext?: InvokeInterceptorContext;
  /**
   * When true, the gateway also exposes the SEP interceptor protocol methods
   * (`interceptors/list`, `interceptor/invoke`, `interceptor/executeChain`)
   * to connecting clients, passed through to the configured interceptor clients.
   *
   * Defaults to `false` (transparent proxy mode).
   */
  exposeInterceptorProtocol?: boolean;
  /** Override the server info advertised to connecting clients. */
  serverInfo?: Implementation;
}

/**
 * A transparent MCP gateway that proxies requests through interceptor chains
 * before forwarding them to a backend MCP server.
 *
 * Mirrors C# `Gateway/McpInterceptorGateway.cs`.
 *
 * Usage:
 * 1. Create connected `Client` instances for the backend and any interceptor servers.
 * 2. Construct an `McpInterceptorGateway` with those clients.
 * 3. Call {@link configureServer} on the proxy `Server` instance.
 * 4. Call {@link registerNotificationForwarding} to forward `*_list_changed`
 *    notifications from the backend through the proxy.
 * 5. Connect the proxy server to its transport.
 */
export class McpInterceptorGateway {
  private readonly chainRunner: InterceptorChainRunner;

  constructor(private readonly options: McpInterceptorGatewayOptions) {
    if (!options.backendClient) {
      throw new Error('McpInterceptorGatewayOptions.backendClient is required');
    }
    if (
      options.exposeInterceptorProtocol &&
      options.interceptorClients.length === 0
    ) {
      throw new Error(
        'exposeInterceptorProtocol requires at least one interceptorClient',
      );
    }
    this.chainRunner = new InterceptorChainRunner(
      options.interceptorClients,
      options.events,
      options.timeoutMs,
      options.defaultContext,
    );
  }

  /**
   * Wires proxy handlers onto the given `Server`. Capabilities are mirrored from
   * the backend; interceptor-extension capability is only advertised when
   * `exposeInterceptorProtocol === true`.
   */
  configureServer(server: Server): void {
    const backend = this.options.backendClient;
    const backendCaps: ServerCapabilities | undefined =
      backend.getServerCapabilities();

    if (this.options.serverInfo) {
      server.registerCapabilities(this.cloneAdvertisedCapabilities(backendCaps));
    } else if (backendCaps) {
      server.registerCapabilities(this.cloneAdvertisedCapabilities(backendCaps));
    }

    if (backendCaps?.tools) {
      this.wireTools(server);
    }
    if (backendCaps?.prompts) {
      this.wirePrompts(server);
    }
    if (backendCaps?.resources) {
      this.wireResources(server);
    }
    if (this.options.exposeInterceptorProtocol) {
      this.wireInterceptorProtocolPassthrough(server);
    }
  }

  /**
   * Subscribes to `*_list_changed` notifications on the backend and re-emits them
   * through the proxy server.
   */
  registerNotificationForwarding(server: Server): void {
    const backend = this.options.backendClient;
    backend.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        await server.sendToolListChanged();
      },
    );
    backend.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        await server.sendPromptListChanged();
      },
    );
    backend.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        await server.sendResourceListChanged();
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  private wireTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async (req) =>
      this.proxy<ListToolsResult>({
        event: InterceptorEvents.ToolsList,
        params: req.params ?? {},
        forward: (mutated) =>
          this.options.backendClient.listTools(
            mutated as Parameters<Client['listTools']>[0],
          ),
      }),
    );
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      this.proxy<CallToolResult>({
        event: InterceptorEvents.ToolsCall,
        params: req.params,
        forward: (mutated) =>
          this.options.backendClient.callTool(
            mutated as Parameters<Client['callTool']>[0],
          ),
      }),
    );
  }

  private wirePrompts(server: Server): void {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      this.proxy<ListPromptsResult>({
        event: InterceptorEvents.PromptsList,
        params: req.params ?? {},
        forward: (mutated) =>
          this.options.backendClient.listPrompts(
            mutated as Parameters<Client['listPrompts']>[0],
          ),
      }),
    );
    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      this.proxy<GetPromptResult>({
        event: InterceptorEvents.PromptsGet,
        params: req.params,
        forward: (mutated) =>
          this.options.backendClient.getPrompt(
            mutated as Parameters<Client['getPrompt']>[0],
          ),
      }),
    );
  }

  private wireResources(server: Server): void {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      this.proxy<ListResourcesResult>({
        event: InterceptorEvents.ResourcesList,
        params: req.params ?? {},
        forward: (mutated) =>
          this.options.backendClient.listResources(
            mutated as Parameters<Client['listResources']>[0],
          ),
      }),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      this.proxy<ReadResourceResult>({
        event: InterceptorEvents.ResourcesRead,
        params: req.params,
        forward: (mutated) =>
          this.options.backendClient.readResource(
            mutated as Parameters<Client['readResource']>[0],
          ),
      }),
    );
    server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      if (
        !this.chainRunner.shouldIntercept(InterceptorEvents.ResourcesSubscribe)
      ) {
        return this.options.backendClient.subscribeResource(req.params);
      }
      const requestPhase = await this.chainRunner.runPhase({
        event: InterceptorEvents.ResourcesSubscribe,
        phase: 'request',
        payload: req.params,
      });
      if (requestPhase.status !== 'success') {
        throwChainFailure({
          operation: 'resources/subscribe',
          phase: 'request',
          status: requestPhase.status,
          chainResult: requestPhase.chainResult,
        });
      }
      return this.options.backendClient.subscribeResource(
        requestPhase.payload as Parameters<Client['subscribeResource']>[0],
      );
    });
  }

  private wireInterceptorProtocolPassthrough(server: Server): void {
    const clients = this.options.interceptorClients;
    if (clients.length === 0) {
      throw new Error(
        'exposeInterceptorProtocol requires at least one interceptorClient',
      );
    }

    // Aggregate `interceptors/list` across all configured interceptor clients.
    server.setRequestHandler(ListInterceptorsRequestSchema, async (req) => {
      const aggregated = await Promise.all(
        clients.map((c) => listInterceptors(c, req.params)),
      );
      return {
        interceptors: aggregated.flatMap((r) => r.interceptors),
      };
    });

    // `interceptor/invoke` targets a single named interceptor. We probe each
    // upstream client's catalogue and route to the first one that hosts it.
    // Per SEP-2624 there is no `interceptor/executeChain` wire method — chain
    // execution is the SDK helper `executeRemoteChain`; we don't expose a
    // gateway passthrough for it.
    server.setRequestHandler(InvokeInterceptorRequestSchema, async (req) => {
      for (const client of clients) {
        const list = await listInterceptors(client);
        if (list.interceptors.some((i) => i.name === req.params.name)) {
          return invokeInterceptor(client, req.params);
        }
      }
      throw new Error(`Interceptor '${req.params.name}' not found on any upstream`);
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async proxy<T>(args: {
    event: string;
    params: unknown;
    forward: (mutatedPayload: unknown) => Promise<unknown>;
  }): Promise<T> {
    if (!this.chainRunner.shouldIntercept(args.event)) {
      return args.forward(args.params) as Promise<T>;
    }

    const requestPhase = await this.chainRunner.runPhase({
      event: args.event,
      phase: 'request',
      payload: args.params,
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
    return responsePhase.payload as T;
  }

  /**
   * Clone the backend's capabilities into the shape the proxy advertises.
   *
   * Always returns a fresh object so we don't mutate the backend client's view.
   * Adds the `interceptors` extension capability when SEP passthrough is enabled.
   */
  private cloneAdvertisedCapabilities(
    backendCaps: ServerCapabilities | undefined,
  ): ServerCapabilities {
    const caps: ServerCapabilities = backendCaps
      ? structuredClone(backendCaps)
      : {};

    if (this.options.exposeInterceptorProtocol) {
      const supportedEvents = this.options.events
        ? [...this.options.events]
        : [];
      caps.experimental = {
        ...(caps.experimental ?? {}),
        [INTERCEPTOR_CAPABILITY_KEY]: { supportedEvents },
      };
    }

    return caps;
  }
}

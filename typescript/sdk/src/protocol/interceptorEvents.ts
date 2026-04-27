// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

/**
 * Interceptable event names from the MCP interceptors extension (SEP-1763).
 *
 * These mirror the C# `InterceptorEvents` constants from
 * `csharp/sdk/src/ModelContextProtocol.Interceptors/Protocol/InterceptorEvents.cs`.
 */
export const InterceptorEvents = {
  // Server feature events
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  PromptsList: 'prompts/list',
  PromptsGet: 'prompts/get',
  ResourcesList: 'resources/list',
  ResourcesRead: 'resources/read',
  ResourcesSubscribe: 'resources/subscribe',

  // Client feature events
  SamplingCreateMessage: 'sampling/createMessage',
  ElicitationCreate: 'elicitation/create',
  RootsList: 'roots/list',

  // LLM interaction events
  LlmCompletion: 'llm/completion',

  // Wildcard patterns
  AllRequests: '*/request',
  AllResponses: '*/response',
  All: '*',
} as const;

export type InterceptorEvent =
  (typeof InterceptorEvents)[keyof typeof InterceptorEvents];

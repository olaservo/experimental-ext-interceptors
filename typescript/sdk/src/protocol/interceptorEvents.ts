// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

/**
 * Interception event names per SEP-2624. Implementations MAY define additional
 * events; SEP-2624 only requires that the wildcard `'*'` matches everything.
 */
export const InterceptorEvents = {
  // MCP Server features
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  PromptsList: 'prompts/list',
  PromptsGet: 'prompts/get',
  ResourcesList: 'resources/list',
  ResourcesRead: 'resources/read',
  ResourcesSubscribe: 'resources/subscribe',

  // MCP Client features
  SamplingCreateMessage: 'sampling/createMessage',
  ElicitationCreate: 'elicitation/create',
  RootsList: 'roots/list',

  // LLM interaction events
  LlmCompletion: 'llm/completion',

  /** Wildcard: matches every event on the declaring hook entry's phase. */
  All: '*',
} as const;

export type InterceptorEvent =
  (typeof InterceptorEvents)[keyof typeof InterceptorEvents];

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Built-in `InterceptionEvent` names. Implementations MAY define custom events
//! following the `namespace/operation` convention; the chain matcher also
//! supports the `"*"` and `"ns/*"` wildcards.

/// Wildcard matching every event.
pub const ALL: &str = "*";

// Server features
pub const TOOLS_LIST: &str = "tools/list";
pub const TOOLS_CALL: &str = "tools/call";
pub const PROMPTS_LIST: &str = "prompts/list";
pub const PROMPTS_GET: &str = "prompts/get";
pub const RESOURCES_LIST: &str = "resources/list";
pub const RESOURCES_READ: &str = "resources/read";
pub const RESOURCES_SUBSCRIBE: &str = "resources/subscribe";

// Client features
pub const SAMPLING_CREATE_MESSAGE: &str = "sampling/createMessage";
pub const ELICITATION_CREATE: &str = "elicitation/create";
pub const ROOTS_LIST: &str = "roots/list";
pub const LLM_COMPLETION: &str = "llm/completion";

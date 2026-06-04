// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The client-boundary mount API — the seam a host (Goose's `ExtensionManager`,
//! codex-core's MCP client, or a gateway) calls to run the interceptor chain on
//! its own MCP traffic.
//!
//! It is JSON-only and deliberately free of any MCP-SDK (`rmcp`) types so the
//! core stays agent-agnostic: a host adapts its native `resources/read` result
//! into a [`serde_json::Value`] before calling in, and reads
//! [`crate::chain::ChainExecutionResult`] back out.

use serde_json::{Map, Value};

use crate::chain::{Chain, ChainExecutionResult, Direction};
use crate::invocation::InvocationContext;
use crate::types::Phase;

/// Run the chain over an **outbound request** the client is about to send.
/// (Client + request = sending: mutations → validations.)
pub async fn execute_request(
    chain: &Chain,
    event: &str,
    payload: Value,
    context: Option<InvocationContext>,
) -> ChainExecutionResult {
    chain
        .execute(
            event,
            Phase::Request,
            Direction::Sending,
            payload,
            context,
            Map::new(),
        )
        .await
}

/// Run the chain over an **inbound response** the client just received — the
/// skill-attribution demo's case. (Client + response = receiving: validations →
/// mutations.)
pub async fn execute_response(
    chain: &Chain,
    event: &str,
    payload: Value,
    context: Option<InvocationContext>,
) -> ChainExecutionResult {
    chain
        .execute(
            event,
            Phase::Response,
            Direction::Receiving,
            payload,
            context,
            Map::new(),
        )
        .await
}

/// Convenience methods on [`Chain`] mirroring the free functions above.
impl Chain {
    /// See [`execute_request`].
    pub async fn execute_request(
        &self,
        event: &str,
        payload: Value,
        context: Option<InvocationContext>,
    ) -> ChainExecutionResult {
        execute_request(self, event, payload, context).await
    }

    /// See [`execute_response`].
    pub async fn execute_response(
        &self,
        event: &str,
        payload: Value,
        context: Option<InvocationContext>,
    ) -> ChainExecutionResult {
        execute_response(self, event, payload, context).await
    }
}

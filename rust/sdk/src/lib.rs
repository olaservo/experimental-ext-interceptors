// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! # MCP Interceptors — Rust SDK
//!
//! A Rust implementation of the MCP Interceptors extension
//! ([SEP-2624](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1763)).
//!
//! This crate implements the SEP-2624 **execution model** — run entirely
//! in-process as the SDK "convenience utility" the spec describes: a
//! validator/mutator [`chain::Chain`] with trust-boundary-aware ordering,
//! parallel validation, sequential & atomic mutation, severity gating, and
//! audit / `failOpen` semantics. It does **not** (yet) implement the JSON-RPC
//! wire methods (`interceptors/list` / `interceptor/invoke`), the interceptor
//! capability advertisement, or a transparent gateway.
//!
//! The types track the canonical SEP-2624 PR
//! (`modelcontextprotocol/modelcontextprotocol#2624`): `mode` is
//! `active | audit` and an interceptor declares a `hooks` array. (This repo's
//! `docs/sep.md` is an edited copy that differs; see [`types`].)
//!
//! Hosts mount the chain at their MCP-client boundary through the agent-agnostic,
//! JSON-only [`mount`] API — no MCP-SDK (`rmcp`) types are involved, so the same
//! interceptor runs unchanged inside Goose, a Codex fork, or a gateway.
//!
//! The flagship interceptor is the [`attribution`] validator, which audits
//! SEP-2640 `SKILL.md` frontmatter for attribution.
//!
//! ## Example
//!
//! ```
//! use std::sync::Arc;
//! use mcp_ext_interceptors::{
//!     attribution::attribution_validator,
//!     chain::Chain,
//!     events::RESOURCES_READ,
//!     invocation::FixedClock,
//! };
//! use serde_json::json;
//!
//! # async fn run() {
//! let clock = Arc::new(FixedClock("2026-06-02T00:00:00Z".into()));
//! let chain = Chain::new().with(attribution_validator(clock));
//!
//! let payload = json!({
//!     "contents": [{
//!         "uri": "skill://pkg/demo/SKILL.md",
//!         "text": "---\nname: demo\n---\nbody"
//!     }]
//! });
//! let result = chain.execute_response(RESOURCES_READ, payload, None).await;
//! assert!(result.results.len() == 1);
//! # }
//! ```

pub mod attribution;
pub mod chain;
pub mod events;
pub mod interceptor;
pub mod invocation;
pub mod mount;
pub mod types;

// Convenient top-level re-exports.
pub use chain::{Chain, ChainExecutionResult, ChainStatus, Direction};
pub use interceptor::{Interceptor, InterceptorError};
pub use invocation::{Clock, FixedClock, Invocation, InvocationContext, Principal, SystemClock};
pub use types::{
    Hook, InterceptorType, InvokeOutput, Metadata, Mode, MutationResult, Phase, Priority, Severity,
    ValidationMessage, ValidationResult,
};

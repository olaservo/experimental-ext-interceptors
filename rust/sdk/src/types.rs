// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Core SEP-2624 data types: interceptor metadata, hooks, priorities, and the
//! validation / mutation result shapes.
//!
//! These mirror the canonical SEP-2624 PR
//! (`modelcontextprotocol/modelcontextprotocol#2624`): `mode` is
//! `active | audit` (default `active`), `hooks` is an array of
//! `{ events, phase }` entries (one phase each), and `priorityHint` is an
//! integer or a `{ request, response }` object.
//!
//! Note: this repo's `docs/sep.md` is an *edited* copy that diverges
//! (`enforce`/`audit`, a single `hook` with `phase: both`, `*/request`
//! wildcards); the in-repo Go SDK follows that copy. This crate intentionally
//! tracks the upstream PR instead.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Whether an interceptor validates (read-only) or mutates the payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterceptorType {
    Validation,
    Mutation,
}

/// The lifecycle phase a hook subscribes to and an interceptor runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Request,
    Response,
}

/// Execution mode. `Audit` interceptors never block and never apply their
/// mutations (the transformation is computed as a "shadow mutation" but
/// discarded).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Normal blocking / transforming behavior (SEP-2624 default).
    #[default]
    Active,
    Audit,
}

/// Validation message severity. Only [`Severity::Error`] blocks the chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

/// Protocol-version compatibility range for an interceptor.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Compat {
    #[serde(rename = "minProtocol")]
    pub min_protocol: String,
    #[serde(rename = "maxProtocol", skip_serializing_if = "Option::is_none")]
    pub max_protocol: Option<String>,
}

/// A priority hint used to order mutators. Lower runs first; ties break
/// alphabetically by interceptor name. A hint may differ per phase, so it
/// serializes either as a single integer (when both phases agree) or as
/// `{ "request": N, "response": M }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Priority {
    pub request: i32,
    pub response: i32,
}

impl Priority {
    /// A priority that is identical in both phases.
    pub fn uniform(value: i32) -> Self {
        Priority {
            request: value,
            response: value,
        }
    }

    /// Resolve the priority value that applies to `phase`.
    pub fn resolve(&self, phase: Phase) -> i32 {
        match phase {
            Phase::Request => self.request,
            Phase::Response => self.response,
        }
    }
}

impl Serialize for Priority {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.request == self.response {
            serializer.serialize_i32(self.request)
        } else {
            use serde::ser::SerializeStruct;
            let mut s = serializer.serialize_struct("Priority", 2)?;
            s.serialize_field("request", &self.request)?;
            s.serialize_field("response", &self.response)?;
            s.end()
        }
    }
}

impl<'de> Deserialize<'de> for Priority {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Scalar(i32),
            PerPhase {
                #[serde(default)]
                request: i32,
                #[serde(default)]
                response: i32,
            },
        }
        Ok(match Raw::deserialize(deserializer)? {
            Raw::Scalar(v) => Priority::uniform(v),
            Raw::PerPhase { request, response } => Priority { request, response },
        })
    }
}

/// One hook entry: a set of lifecycle events and the single phase they fire on.
/// An interceptor that runs on both phases uses two entries.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hook {
    /// Event names this hook fires on, e.g. `["resources/read"]`. `"*"` matches
    /// every event (on this entry's phase); a trailing `"ns/*"` matches that
    /// namespace (a SEP-2624 MAY this SDK supports).
    pub events: Vec<String>,
    pub phase: Phase,
}

impl Hook {
    /// True if this hook fires for `event` in `phase`.
    pub fn matches(&self, event: &str, phase: Phase) -> bool {
        self.phase == phase && self.events.iter().any(|e| event_matches(e, event))
    }
}

/// Match a configured event pattern against a concrete event name. Supports
/// exact match, the `"*"` wildcard, and a trailing `"ns/*"` namespace prefix.
pub fn event_matches(pattern: &str, event: &str) -> bool {
    if pattern == "*" || pattern == event {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        return event.starts_with(prefix) && event[prefix.len()..].starts_with('/');
    }
    false
}

/// All metadata describing an interceptor. Returned by `interceptors/list` (the
/// wire method, not yet implemented here) and used by the in-process chain
/// executor for filtering and ordering.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub interceptor_type: InterceptorType,
    pub hooks: Vec<Hook>,
    #[serde(default)]
    pub mode: Mode,
    #[serde(rename = "failOpen", default)]
    pub fail_open: bool,
    #[serde(rename = "priorityHint", default)]
    pub priority_hint: Priority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compat: Option<Compat>,
    #[serde(rename = "configSchema", skip_serializing_if = "Option::is_none")]
    pub config_schema: Option<serde_json::Value>,
}

impl Metadata {
    /// Convenience constructor taking the hook's events and phase.
    pub fn new(
        name: impl Into<String>,
        interceptor_type: InterceptorType,
        events: Vec<String>,
        phase: Phase,
    ) -> Self {
        Metadata {
            name: name.into(),
            version: None,
            description: None,
            interceptor_type,
            hooks: vec![Hook { events, phase }],
            mode: Mode::Active,
            fail_open: false,
            priority_hint: Priority::default(),
            compat: None,
            config_schema: None,
        }
    }

    /// True if any of this interceptor's hooks fire for `event` in `phase`.
    pub fn matches(&self, event: &str, phase: Phase) -> bool {
        self.hooks.iter().any(|h| h.matches(event, phase))
    }
}

/// A single validation finding.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidationMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
    pub severity: Severity,
}

/// An optional suggested correction returned by a validator.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidationSuggestion {
    pub path: String,
    pub value: serde_json::Value,
}

/// The result of a validation interceptor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidationResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<ValidationMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<ValidationSuggestion>,
}

impl ValidationResult {
    /// A passing result with no messages.
    pub fn success() -> Self {
        ValidationResult {
            valid: true,
            severity: None,
            messages: vec![],
            suggestions: vec![],
        }
    }

    /// True if this result carries an error-severity finding (and therefore
    /// blocks the chain unless its interceptor is in audit mode).
    ///
    /// NOTE: the SEP's execution model keys blocking strictly on
    /// `severity == "error"`. We additionally treat `valid == false` as
    /// blocking — slightly broader than the spec — on the view that a validator
    /// declaring the payload invalid intends to block even if it forgot to set
    /// the severity. In practice the two agree (validators set them together).
    pub fn has_error(&self) -> bool {
        !self.valid
            || self.severity == Some(Severity::Error)
            || self.messages.iter().any(|m| m.severity == Severity::Error)
    }
}

/// The result of a mutation interceptor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MutationResult {
    pub modified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

impl MutationResult {
    /// A result indicating the payload was left unchanged.
    pub fn unchanged() -> Self {
        MutationResult {
            modified: false,
            info: None,
            payload: None,
        }
    }

    /// A result carrying a transformed payload.
    pub fn mutated(payload: serde_json::Value) -> Self {
        MutationResult {
            modified: true,
            info: None,
            payload: Some(payload),
        }
    }
}

/// What an interceptor handler returns: a type-specific result plus an optional
/// free-form `info` record (the SEP envelope's `info` field — deliberately
/// named to avoid confusion with MCP's `_meta`).
#[derive(Clone, Debug, Default)]
pub struct InvokeOutput {
    pub validation: Option<ValidationResult>,
    pub mutation: Option<MutationResult>,
    pub info: Option<serde_json::Value>,
}

impl InvokeOutput {
    /// Build a validation output.
    pub fn validation(result: ValidationResult) -> Self {
        InvokeOutput {
            validation: Some(result),
            mutation: None,
            info: None,
        }
    }

    /// Build a mutation output.
    pub fn mutation(result: MutationResult) -> Self {
        InvokeOutput {
            validation: None,
            mutation: Some(result),
            info: None,
        }
    }

    /// Attach a free-form `info` record (e.g. an audit tuple).
    pub fn with_info(mut self, info: serde_json::Value) -> Self {
        self.info = Some(info);
        self
    }
}

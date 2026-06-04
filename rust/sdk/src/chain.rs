// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The SEP-2624 execution model: an in-process chain runner that enforces
//! trust-boundary-aware ordering, parallel validation, sequential and atomic
//! mutation, severity gating, and audit / `failOpen` semantics.
//!
//! Per the spec, chain execution "is a convenience utility, provided by SDKs to
//! enforce the execution model" — it is not itself a wire method. Hosts (Goose,
//! Codex, a gateway) mount it at their MCP-client boundary via [`crate::mount`].

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::interceptor::Interceptor;
use crate::invocation::{Invocation, InvocationContext};
use crate::types::{InterceptorType, MutationResult, Phase, Severity, ValidationResult};

/// Whether the chain runs on the *sending* or *receiving* side of a trust
/// boundary. This — not the phase — determines validator/mutator ordering.
///
/// | Actor  | Phase    | Direction   |
/// |--------|----------|-------------|
/// | Client | request  | `Sending`   |
/// | Server | request  | `Receiving` |
/// | Server | response | `Sending`   |
/// | Client | response | `Receiving` |
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Outbound across the boundary: mutations → validations → send.
    Sending,
    /// Inbound across the boundary: receive → validations → mutations.
    Receiving,
}

/// Terminal status of a chain execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainStatus {
    Success,
    ValidationFailed,
    MutationFailed,
}

/// Why and where the chain aborted.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AbortInfo {
    pub interceptor: String,
    pub reason: String,
}

/// Per-interceptor record. Serializes to the **flat** SEP-2624
/// `interceptor/invoke` result shape: the common fields (`interceptor`, `type`,
/// `phase`, `durationMs`, `info`) and the type-specific fields (`valid`,
/// `severity`, `messages`, `suggestions` for validators; `modified`, `payload`
/// for mutators) all sit at the top level. `error` is an SDK extension set when
/// the interceptor threw or timed out (the spec returns a JSON-RPC error there).
#[derive(Clone, Debug)]
pub struct InvokeRecord {
    pub interceptor: String,
    pub interceptor_type: InterceptorType,
    pub phase: Phase,
    pub duration_ms: u64,
    pub validation: Option<ValidationResult>,
    pub mutation: Option<MutationResult>,
    pub info: Option<Value>,
    /// Set when the interceptor threw or timed out.
    pub error: Option<String>,
}

impl Serialize for InvokeRecord {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("interceptor", &self.interceptor)?;
        map.serialize_entry("type", &self.interceptor_type)?;
        map.serialize_entry("phase", &self.phase)?;
        map.serialize_entry("durationMs", &self.duration_ms)?;
        if let Some(ref v) = self.validation {
            map.serialize_entry("valid", &v.valid)?;
            if let Some(sev) = v.severity {
                map.serialize_entry("severity", &sev)?;
            }
            if !v.messages.is_empty() {
                map.serialize_entry("messages", &v.messages)?;
            }
            if !v.suggestions.is_empty() {
                map.serialize_entry("suggestions", &v.suggestions)?;
            }
        }
        if let Some(ref m) = self.mutation {
            map.serialize_entry("modified", &m.modified)?;
            if let Some(ref p) = m.payload {
                map.serialize_entry("payload", p)?;
            }
        }
        // `info`: the record's own info, falling back to a mutator's result info.
        let info = self
            .info
            .as_ref()
            .or_else(|| self.mutation.as_ref().and_then(|m| m.info.as_ref()));
        if let Some(info) = info {
            map.serialize_entry("info", info)?;
        }
        if let Some(ref e) = self.error {
            map.serialize_entry("error", e)?;
        }
        map.end()
    }
}

/// Tally of validation messages by severity across the chain.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct ValidationSummary {
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
}

/// The outcome of running the chain for one event/phase.
#[derive(Clone, Debug, Serialize)]
pub struct ChainExecutionResult {
    pub status: ChainStatus,
    pub event: String,
    pub phase: Phase,
    pub results: Vec<InvokeRecord>,
    #[serde(rename = "finalPayload")]
    pub final_payload: Value,
    #[serde(rename = "validationSummary")]
    pub validation_summary: ValidationSummary,
    #[serde(rename = "abortedAt", skip_serializing_if = "Vec::is_empty")]
    pub aborts: Vec<AbortInfo>,
}

impl ChainExecutionResult {
    /// True if the chain completed without a blocking abort.
    pub fn ok(&self) -> bool {
        self.aborts.is_empty() && self.status == ChainStatus::Success
    }
}

/// An in-process interceptor chain. Register interceptors with [`Chain::with`]
/// then run them with [`Chain::execute`] (or the [`crate::mount`] helpers).
#[derive(Clone, Default)]
pub struct Chain {
    interceptors: Vec<Arc<dyn Interceptor>>,
    timeout: Option<Duration>,
}

impl Chain {
    /// A new, empty chain.
    pub fn new() -> Self {
        Chain {
            interceptors: Vec::new(),
            timeout: None,
        }
    }

    /// Register an interceptor (builder style).
    pub fn with(mut self, interceptor: Arc<dyn Interceptor>) -> Self {
        self.interceptors.push(interceptor);
        self
    }

    /// Register an interceptor in place.
    pub fn add(&mut self, interceptor: Arc<dyn Interceptor>) -> &mut Self {
        self.interceptors.push(interceptor);
        self
    }

    /// Apply a per-interceptor timeout. An interceptor that exceeds it is
    /// treated as a throw (subject to `failOpen`).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Number of registered interceptors.
    pub fn len(&self) -> usize {
        self.interceptors.len()
    }

    /// True if no interceptors are registered.
    pub fn is_empty(&self) -> bool {
        self.interceptors.is_empty()
    }

    /// Run the chain for `event`/`phase` in the given `direction`.
    ///
    /// - **Receiving**: validations (parallel) → mutations (sequential).
    /// - **Sending**: mutations (sequential) → validations (parallel), so
    ///   validators always see the post-mutation payload.
    ///
    /// Mutations are atomic: if any mutator aborts, no mutations are applied and
    /// `final_payload` is the original input.
    pub async fn execute(
        &self,
        event: &str,
        phase: Phase,
        direction: Direction,
        payload: Value,
        context: Option<InvocationContext>,
        config: Map<String, Value>,
    ) -> ChainExecutionResult {
        let mut validators: Vec<Arc<dyn Interceptor>> = Vec::new();
        let mut mutators: Vec<Arc<dyn Interceptor>> = Vec::new();
        for ix in &self.interceptors {
            if !ix.metadata().matches(event, phase) {
                continue;
            }
            match ix.interceptor_type() {
                InterceptorType::Validation => validators.push(ix.clone()),
                InterceptorType::Mutation => mutators.push(ix.clone()),
            }
        }
        // Mutators: ascending priority, alphabetical tiebreak by name.
        mutators.sort_by(|a, b| {
            let pa = a.metadata().priority_hint.resolve(phase);
            let pb = b.metadata().priority_hint.resolve(phase);
            pa.cmp(&pb)
                .then_with(|| a.metadata().name.cmp(&b.metadata().name))
        });

        let mut records: Vec<InvokeRecord> = Vec::new();
        let mut aborts: Vec<AbortInfo> = Vec::new();
        let final_payload: Value;

        match direction {
            Direction::Receiving => {
                // receive → validations → mutations
                let (vrecs, vaborts) = self
                    .run_validators(&validators, event, phase, &payload, &context, &config)
                    .await;
                records.extend(vrecs);
                if !vaborts.is_empty() {
                    aborts.extend(vaborts);
                    return finalize(
                        event,
                        phase,
                        records,
                        payload,
                        aborts,
                        ChainStatus::ValidationFailed,
                    );
                }
                let (mutated, mrecs, maborts) = self
                    .run_mutators(&mutators, event, phase, payload.clone(), &context, &config)
                    .await;
                records.extend(mrecs);
                if !maborts.is_empty() {
                    aborts.extend(maborts);
                    return finalize(
                        event,
                        phase,
                        records,
                        payload,
                        aborts,
                        ChainStatus::MutationFailed,
                    );
                }
                final_payload = mutated;
            }
            Direction::Sending => {
                // mutations → validations → send
                let (mutated, mrecs, maborts) = self
                    .run_mutators(&mutators, event, phase, payload.clone(), &context, &config)
                    .await;
                records.extend(mrecs);
                if !maborts.is_empty() {
                    aborts.extend(maborts);
                    return finalize(
                        event,
                        phase,
                        records,
                        payload,
                        aborts,
                        ChainStatus::MutationFailed,
                    );
                }
                // Validators see the post-mutation payload.
                let (vrecs, vaborts) = self
                    .run_validators(&validators, event, phase, &mutated, &context, &config)
                    .await;
                records.extend(vrecs);
                if !vaborts.is_empty() {
                    aborts.extend(vaborts);
                    // Validation failed after mutating: do not apply mutations.
                    return finalize(
                        event,
                        phase,
                        records,
                        payload,
                        aborts,
                        ChainStatus::ValidationFailed,
                    );
                }
                final_payload = mutated;
            }
        }

        let summary = summarize(&records);
        ChainExecutionResult {
            status: ChainStatus::Success,
            event: event.to_string(),
            phase,
            results: records,
            final_payload,
            validation_summary: summary,
            aborts,
        }
    }

    /// Run all validators concurrently against the same (read-only) payload.
    async fn run_validators(
        &self,
        validators: &[Arc<dyn Interceptor>],
        event: &str,
        phase: Phase,
        payload: &Value,
        context: &Option<InvocationContext>,
        config: &Map<String, Value>,
    ) -> (Vec<InvokeRecord>, Vec<AbortInfo>) {
        let futures = validators.iter().map(|ix| {
            let inv = Invocation {
                event: event.to_string(),
                phase,
                payload: payload.clone(),
                config: config.clone(),
                context: context.clone(),
            };
            async move {
                let started = Instant::now();
                let outcome = self.invoke_one(ix.as_ref(), &inv).await;
                (ix.clone(), started.elapsed(), outcome)
            }
        });
        let results = join_all(futures).await;

        let mut records = Vec::new();
        let mut aborts = Vec::new();
        for (ix, elapsed, outcome) in results {
            let meta = ix.metadata();
            let mut record = InvokeRecord {
                interceptor: meta.name.clone(),
                interceptor_type: InterceptorType::Validation,
                phase,
                duration_ms: elapsed.as_millis() as u64,
                validation: None,
                mutation: None,
                info: None,
                error: None,
            };
            match outcome {
                Ok(output) => {
                    record.info = output.info;
                    let vr = output.validation.unwrap_or_else(ValidationResult::success);
                    let blocking = vr.has_error() && meta.mode != crate::types::Mode::Audit;
                    if blocking {
                        let reason = first_error_message(&vr)
                            .unwrap_or_else(|| "validation failed".to_string());
                        aborts.push(AbortInfo {
                            interceptor: meta.name.clone(),
                            reason,
                        });
                    }
                    record.validation = Some(vr);
                }
                Err(reason) => {
                    record.error = Some(reason.clone());
                    // A throw/timeout aborts unless the interceptor fails open.
                    if !meta.fail_open && meta.mode != crate::types::Mode::Audit {
                        aborts.push(AbortInfo {
                            interceptor: meta.name.clone(),
                            reason,
                        });
                    }
                }
            }
            records.push(record);
        }
        (records, aborts)
    }

    /// Run mutators sequentially, threading the payload. Atomic: if any mutator
    /// aborts, the returned payload is the original input.
    async fn run_mutators(
        &self,
        mutators: &[Arc<dyn Interceptor>],
        event: &str,
        phase: Phase,
        original: Value,
        context: &Option<InvocationContext>,
        config: &Map<String, Value>,
    ) -> (Value, Vec<InvokeRecord>, Vec<AbortInfo>) {
        let mut staged = original.clone();
        let mut records = Vec::new();
        let mut aborts = Vec::new();

        for ix in mutators {
            let meta = ix.metadata();
            let inv = Invocation {
                event: event.to_string(),
                phase,
                payload: staged.clone(),
                config: config.clone(),
                context: context.clone(),
            };
            let started = Instant::now();
            let outcome = self.invoke_one(ix.as_ref(), &inv).await;
            let mut record = InvokeRecord {
                interceptor: meta.name.clone(),
                interceptor_type: InterceptorType::Mutation,
                phase,
                duration_ms: started.elapsed().as_millis() as u64,
                validation: None,
                mutation: None,
                info: None,
                error: None,
            };
            match outcome {
                Ok(output) => {
                    record.info = output.info;
                    let mr = output.mutation.unwrap_or_else(MutationResult::unchanged);
                    // Audit-mode mutators compute a shadow mutation that is never
                    // applied to the threaded payload.
                    if meta.mode != crate::types::Mode::Audit && mr.modified {
                        if let Some(ref new_payload) = mr.payload {
                            staged = new_payload.clone();
                        }
                    }
                    record.mutation = Some(mr);
                    records.push(record);
                }
                Err(reason) => {
                    record.error = Some(reason.clone());
                    records.push(record);
                    if !meta.fail_open && meta.mode != crate::types::Mode::Audit {
                        aborts.push(AbortInfo {
                            interceptor: meta.name.clone(),
                            reason,
                        });
                        // Roll back to the original payload (drop all staged
                        // mutations). NOTE: the SEP is self-contradictory here —
                        // the Execution-Model summary mandates "MUST be atomic:
                        // the entire chain succeeds or none of the mutations
                        // apply", while the type-behavior table says failure
                        // "returns last valid state". We follow the stronger
                        // "MUST be atomic" wording and roll back.
                        return (original, records, aborts);
                    }
                    // fail-open: leave `staged` unchanged and continue.
                }
            }
        }
        (staged, records, aborts)
    }

    /// Invoke a single interceptor, applying the per-interceptor timeout if set.
    async fn invoke_one(
        &self,
        ix: &dyn Interceptor,
        inv: &Invocation,
    ) -> Result<crate::types::InvokeOutput, String> {
        match self.timeout {
            Some(t) => match tokio::time::timeout(t, ix.invoke(inv)).await {
                Ok(Ok(output)) => Ok(output),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!("interceptor timed out after {}ms", t.as_millis())),
            },
            None => ix.invoke(inv).await.map_err(|e| e.to_string()),
        }
    }
}

fn first_error_message(vr: &ValidationResult) -> Option<String> {
    vr.messages
        .iter()
        .find(|m| m.severity == Severity::Error)
        .map(|m| m.message.clone())
}

fn summarize(records: &[InvokeRecord]) -> ValidationSummary {
    let mut s = ValidationSummary::default();
    for r in records {
        if let Some(ref vr) = r.validation {
            for m in &vr.messages {
                match m.severity {
                    Severity::Error => s.errors += 1,
                    Severity::Warn => s.warnings += 1,
                    Severity::Info => s.infos += 1,
                }
            }
        }
    }
    s
}

fn finalize(
    event: &str,
    phase: Phase,
    records: Vec<InvokeRecord>,
    final_payload: Value,
    aborts: Vec<AbortInfo>,
    status: ChainStatus,
) -> ChainExecutionResult {
    let summary = summarize(&records);
    ChainExecutionResult {
        status,
        event: event.to_string(),
        phase,
        results: records,
        final_payload,
        validation_summary: summary,
        aborts,
    }
}

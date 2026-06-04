// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Execution-model tests for the chain: ordering, severity gating,
//! audit / fail-open semantics, hook filtering, timeouts, and serde shapes.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mcp_ext_interceptors::chain::{Chain, ChainStatus, Direction};
use mcp_ext_interceptors::events::{RESOURCES_READ, TOOLS_CALL};
use mcp_ext_interceptors::interceptor::{Interceptor, InterceptorError};
use mcp_ext_interceptors::invocation::Invocation;
use mcp_ext_interceptors::types::{
    InterceptorType, InvokeOutput, Metadata, Mode, MutationResult, Phase, Priority, Severity,
    ValidationMessage, ValidationResult,
};
use serde_json::{json, Map, Value};

// ---- test interceptor -------------------------------------------------------

enum Behavior {
    Validate(ValidationResult),
    AppendOrder,
    ShadowMutate(Value),
    Throw(String),
    Slow(u64),
}

struct Programmed {
    meta: Metadata,
    behavior: Behavior,
}

#[async_trait]
impl Interceptor for Programmed {
    fn metadata(&self) -> &Metadata {
        &self.meta
    }

    async fn invoke(&self, inv: &Invocation) -> Result<InvokeOutput, InterceptorError> {
        match &self.behavior {
            Behavior::Validate(vr) => Ok(InvokeOutput::validation(vr.clone())),
            Behavior::AppendOrder => {
                let mut p = inv.payload.clone();
                let obj = p.as_object_mut().expect("payload must be an object");
                let arr = obj.entry("order").or_insert_with(|| json!([]));
                arr.as_array_mut().unwrap().push(json!(self.meta.name));
                Ok(InvokeOutput::mutation(MutationResult::mutated(p)))
            }
            Behavior::ShadowMutate(v) => {
                Ok(InvokeOutput::mutation(MutationResult::mutated(v.clone())))
            }
            Behavior::Throw(msg) => Err(msg.clone().into()),
            Behavior::Slow(ms) => {
                tokio::time::sleep(Duration::from_millis(*ms)).await;
                Ok(InvokeOutput::validation(ValidationResult::success()))
            }
        }
    }
}

fn vmeta(name: &str, mode: Mode, fail_open: bool) -> Metadata {
    let mut m = Metadata::new(
        name,
        InterceptorType::Validation,
        vec![RESOURCES_READ.to_string()],
        Phase::Response,
    );
    m.mode = mode;
    m.fail_open = fail_open;
    m
}

fn mmeta(name: &str, prio: i32, mode: Mode, fail_open: bool) -> Metadata {
    let mut m = Metadata::new(
        name,
        InterceptorType::Mutation,
        vec![RESOURCES_READ.to_string()],
        Phase::Response,
    );
    m.priority_hint = Priority::uniform(prio);
    m.mode = mode;
    m.fail_open = fail_open;
    m
}

fn validator(name: &str, behavior: Behavior, mode: Mode, fail_open: bool) -> Arc<dyn Interceptor> {
    Arc::new(Programmed {
        meta: vmeta(name, mode, fail_open),
        behavior,
    })
}

fn error_result() -> ValidationResult {
    ValidationResult {
        valid: false,
        severity: Some(Severity::Error),
        messages: vec![ValidationMessage {
            path: None,
            message: "blocked".to_string(),
            severity: Severity::Error,
        }],
        suggestions: vec![],
    }
}

fn warn_result() -> ValidationResult {
    ValidationResult {
        valid: true,
        severity: Some(Severity::Warn),
        messages: vec![ValidationMessage {
            path: None,
            message: "heads up".to_string(),
            severity: Severity::Warn,
        }],
        suggestions: vec![],
    }
}

async fn run(chain: &Chain, payload: Value) -> mcp_ext_interceptors::chain::ChainExecutionResult {
    chain.execute_response(RESOURCES_READ, payload, None).await
}

// ---- validation -------------------------------------------------------------

#[tokio::test]
async fn passing_validator_succeeds() {
    let chain = Chain::new().with(validator(
        "ok",
        Behavior::Validate(ValidationResult::success()),
        Mode::Active,
        false,
    ));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(r.results.len(), 1);
    assert!(r.ok());
}

#[tokio::test]
async fn error_severity_blocks() {
    let chain = Chain::new().with(validator(
        "blocker",
        Behavior::Validate(error_result()),
        Mode::Active,
        false,
    ));
    let r = run(&chain, json!({"keep": true})).await;
    assert_eq!(r.status, ChainStatus::ValidationFailed);
    assert_eq!(r.aborts.len(), 1);
    assert_eq!(r.aborts[0].interceptor, "blocker");
    // Payload is unchanged on a validation abort.
    assert_eq!(r.final_payload, json!({"keep": true}));
}

#[tokio::test]
async fn warn_does_not_block() {
    let chain = Chain::new().with(validator(
        "warner",
        Behavior::Validate(warn_result()),
        Mode::Active,
        false,
    ));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(r.validation_summary.warnings, 1);
    assert!(r.aborts.is_empty());
}

#[tokio::test]
async fn audit_mode_error_does_not_block() {
    let chain = Chain::new().with(validator(
        "auditor",
        Behavior::Validate(error_result()),
        Mode::Audit,
        false,
    ));
    let r = run(&chain, json!({})).await;
    assert_eq!(
        r.status,
        ChainStatus::Success,
        "audit-mode error must not block"
    );
    assert!(r.aborts.is_empty());
}

#[tokio::test]
async fn throwing_validator_blocks_unless_failopen() {
    let blocking = Chain::new().with(validator(
        "thrower",
        Behavior::Throw("boom".into()),
        Mode::Active,
        false,
    ));
    let r = run(&blocking, json!({})).await;
    assert_eq!(r.status, ChainStatus::ValidationFailed);
    assert_eq!(r.aborts[0].reason, "boom");

    let failopen = Chain::new().with(validator(
        "thrower",
        Behavior::Throw("boom".into()),
        Mode::Active,
        true,
    ));
    let r = run(&failopen, json!({})).await;
    assert_eq!(
        r.status,
        ChainStatus::Success,
        "fail-open throw must not block"
    );
    assert!(r.results[0].error.is_some());
}

// ---- mutation ---------------------------------------------------------------

#[tokio::test]
async fn mutators_run_in_priority_then_alpha_order() {
    // Register out of order; expect resolved order: c(-5), a(10), b(10).
    let chain = Chain::new()
        .with(Arc::new(Programmed {
            meta: mmeta("b", 10, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }))
        .with(Arc::new(Programmed {
            meta: mmeta("a", 10, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }))
        .with(Arc::new(Programmed {
            meta: mmeta("c", -5, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(r.final_payload["order"], json!(["c", "a", "b"]));
}

#[tokio::test]
async fn mutations_are_atomic_on_failure() {
    let chain = Chain::new()
        .with(Arc::new(Programmed {
            meta: mmeta("first", 1, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }))
        .with(Arc::new(Programmed {
            meta: mmeta("boom", 2, Mode::Active, false),
            behavior: Behavior::Throw("nope".into()),
        }));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::MutationFailed);
    // First mutator's change must be rolled back (atomic).
    assert_eq!(r.final_payload, json!({}), "no mutations should be applied");
}

#[tokio::test]
async fn failopen_mutator_continues_chain() {
    let chain = Chain::new()
        .with(Arc::new(Programmed {
            meta: mmeta("flaky", 1, Mode::Active, true),
            behavior: Behavior::Throw("transient".into()),
        }))
        .with(Arc::new(Programmed {
            meta: mmeta("good", 2, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(r.final_payload["order"], json!(["good"]));
}

#[tokio::test]
async fn audit_mutator_shadow_is_not_applied() {
    let chain = Chain::new().with(Arc::new(Programmed {
        meta: mmeta("shadow", 1, Mode::Audit, false),
        behavior: Behavior::ShadowMutate(json!({"order": ["shadow"]})),
    }));
    let r = run(&chain, json!({"original": true})).await;
    assert_eq!(r.status, ChainStatus::Success);
    // Shadow mutation computed but not applied.
    assert_eq!(r.final_payload, json!({"original": true}));
    let mutation = r.results[0].mutation.as_ref().unwrap();
    assert!(mutation.modified);
}

// ---- ordering across directions --------------------------------------------

#[tokio::test]
async fn sending_runs_mutators_before_validators() {
    // A mutator adds `order`, a validator records whether it saw it. On the
    // sending side the validator must observe the mutated payload.
    struct SawOrder(Arc<std::sync::Mutex<bool>>, Metadata);
    #[async_trait]
    impl Interceptor for SawOrder {
        fn metadata(&self) -> &Metadata {
            &self.1
        }
        async fn invoke(&self, inv: &Invocation) -> Result<InvokeOutput, InterceptorError> {
            *self.0.lock().unwrap() = inv.payload.get("order").is_some();
            Ok(InvokeOutput::validation(ValidationResult::success()))
        }
    }
    let saw = Arc::new(std::sync::Mutex::new(false));
    let chain = Chain::new()
        .with(Arc::new(Programmed {
            meta: mmeta("m", 1, Mode::Active, false),
            behavior: Behavior::AppendOrder,
        }))
        .with(Arc::new(SawOrder(
            saw.clone(),
            vmeta("v", Mode::Active, false),
        )));

    let r = chain
        .execute(
            RESOURCES_READ,
            Phase::Response,
            Direction::Sending,
            json!({}),
            None,
            Map::new(),
        )
        .await;
    assert_eq!(r.status, ChainStatus::Success);
    assert!(
        *saw.lock().unwrap(),
        "validator should see the post-mutation payload when sending"
    );
}

// ---- hook filtering ---------------------------------------------------------

#[tokio::test]
async fn non_matching_event_is_skipped() {
    let mut meta = Metadata::new(
        "tools-only",
        InterceptorType::Validation,
        vec![TOOLS_CALL.to_string()],
        Phase::Response,
    );
    meta.mode = Mode::Active;
    let chain = Chain::new().with(Arc::new(Programmed {
        meta,
        behavior: Behavior::Validate(error_result()),
    }));
    // Validator is hooked on tools/call, so a resources/read run skips it.
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert!(r.results.is_empty());
}

fn passing_validator(name: &str, events: &[&str], phase: Phase) -> Arc<dyn Interceptor> {
    let meta = Metadata::new(
        name,
        InterceptorType::Validation,
        events.iter().map(|s| s.to_string()).collect(),
        phase,
    );
    Arc::new(Programmed {
        meta,
        behavior: Behavior::Validate(ValidationResult::success()),
    })
}

#[tokio::test]
async fn wildcard_event_matches_anything() {
    let chain = Chain::new().with(passing_validator("everything", &["*"], Phase::Response));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.results.len(), 1);
}

#[tokio::test]
async fn namespace_wildcard_matches_prefix() {
    let chain = Chain::new().with(passing_validator("tools", &["tools/*"], Phase::Response));
    let on_tools_call = chain.execute_response(TOOLS_CALL, json!({}), None).await;
    let on_resources_read = chain
        .execute_response(RESOURCES_READ, json!({}), None)
        .await;
    assert_eq!(
        on_tools_call.results.len(),
        1,
        "tools/* should match tools/call"
    );
    assert_eq!(
        on_resources_read.results.len(),
        0,
        "tools/* must not match resources/read"
    );
}

#[tokio::test]
async fn two_hook_entries_fire_on_each_phase() {
    // SEP-2624 expresses "both phases" as two hook entries, one per phase.
    let mut meta = Metadata::new(
        "both",
        InterceptorType::Validation,
        vec![RESOURCES_READ.to_string()],
        Phase::Response,
    );
    meta.hooks.push(mcp_ext_interceptors::types::Hook {
        events: vec![RESOURCES_READ.to_string()],
        phase: Phase::Request,
    });
    let chain = Chain::new().with(Arc::new(Programmed {
        meta,
        behavior: Behavior::Validate(ValidationResult::success()),
    }));
    let on_response = chain
        .execute_response(RESOURCES_READ, json!({}), None)
        .await;
    let on_request = chain.execute_request(RESOURCES_READ, json!({}), None).await;
    assert_eq!(on_response.results.len(), 1);
    assert_eq!(on_request.results.len(), 1);
}

// ---- timeout ----------------------------------------------------------------

#[tokio::test]
async fn slow_interceptor_times_out_and_blocks() {
    let chain = Chain::new()
        .with(validator("slow", Behavior::Slow(200), Mode::Active, false))
        .with_timeout(Duration::from_millis(20));
    let r = run(&chain, json!({})).await;
    assert_eq!(r.status, ChainStatus::ValidationFailed);
    assert_eq!(r.aborts.len(), 1);
    assert!(r.aborts[0].reason.contains("timed out"));
}

// ---- serde shapes -----------------------------------------------------------

#[test]
fn priority_serializes_scalar_and_per_phase() {
    assert_eq!(
        serde_json::to_value(Priority::uniform(5)).unwrap(),
        json!(5)
    );
    let pp = Priority {
        request: 1,
        response: 2,
    };
    assert_eq!(
        serde_json::to_value(pp).unwrap(),
        json!({"request": 1, "response": 2})
    );

    let scalar: Priority = serde_json::from_value(json!(-7)).unwrap();
    assert_eq!(scalar, Priority::uniform(-7));
    let obj: Priority = serde_json::from_value(json!({"request": 3, "response": 4})).unwrap();
    assert_eq!(
        obj,
        Priority {
            request: 3,
            response: 4
        }
    );
}

#[test]
fn metadata_round_trips() {
    let mut meta = Metadata::new(
        "rt",
        InterceptorType::Mutation,
        vec![RESOURCES_READ.to_string()],
        Phase::Request,
    );
    meta.mode = Mode::Audit;
    meta.fail_open = true;
    meta.priority_hint = Priority {
        request: -1000,
        response: 0,
    };
    let v = serde_json::to_value(&meta).unwrap();
    assert_eq!(v["type"], json!("mutation"));
    assert_eq!(v["mode"], json!("audit"));
    assert_eq!(v["failOpen"], json!(true));
    assert_eq!(v["priorityHint"], json!({"request": -1000, "response": 0}));
    // Spec shape (PR #2624): a `hooks` array of `{ events, phase }` entries.
    assert_eq!(v["hooks"][0]["events"], json!(["resources/read"]));
    assert_eq!(v["hooks"][0]["phase"], json!("request"));
    assert!(v.get("hook").is_none());
    let back: Metadata = serde_json::from_value(v).unwrap();
    assert_eq!(back.name, "rt");
    assert_eq!(back.mode, Mode::Audit);
    assert_eq!(back.hooks[0].phase, Phase::Request);
}

#[tokio::test]
async fn invoke_record_serializes_flat() {
    // The per-interceptor record must use the spec's flat result shape:
    // type-specific fields at top level, not nested under `validation`.
    let chain = Chain::new().with(validator(
        "warner",
        Behavior::Validate(warn_result()),
        Mode::Active,
        false,
    ));
    let r = run(&chain, json!({})).await;
    let rec = serde_json::to_value(&r.results[0]).unwrap();
    assert_eq!(rec["interceptor"], json!("warner"));
    assert_eq!(rec["type"], json!("validation"));
    assert_eq!(rec["phase"], json!("response"));
    assert_eq!(rec["valid"], json!(true));
    assert_eq!(rec["severity"], json!("warn"));
    assert!(rec["messages"].is_array());
    assert!(rec["durationMs"].is_number());
    // No nesting under `validation` / `mutation`.
    assert!(rec.get("validation").is_none());
    assert!(rec.get("mutation").is_none());
}

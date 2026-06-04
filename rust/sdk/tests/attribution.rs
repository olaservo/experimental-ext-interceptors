// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Tests for the skill-attribution validator: per-fixture grades and severities,
//! metadata-first field resolution, and the layered-provenance rule.

use std::sync::Arc;

use mcp_ext_interceptors::attribution::attribution_validator;
use mcp_ext_interceptors::chain::{Chain, ChainExecutionResult, ChainStatus};
use mcp_ext_interceptors::events::RESOURCES_READ;
use mcp_ext_interceptors::invocation::FixedClock;
use mcp_ext_interceptors::types::Severity;
use serde_json::{json, Value};

const FIXED_TS: &str = "2026-06-02T00:00:00Z";

fn chain() -> Chain {
    Chain::new().with(attribution_validator(Arc::new(FixedClock(
        FIXED_TS.to_string(),
    ))))
}

fn read(uri: &str, text: Option<&str>) -> Value {
    let mut content = json!({ "uri": uri, "mimeType": "text/markdown" });
    if let Some(t) = text {
        content["text"] = json!(t);
    }
    json!({ "contents": [content] })
}

async fn audit(payload: Value) -> ChainExecutionResult {
    chain()
        .execute_response(RESOURCES_READ, payload, None)
        .await
}

fn info_of(r: &ChainExecutionResult) -> Option<&Value> {
    r.results.first().and_then(|rec| rec.info.as_ref())
}

fn compliance_of(r: &ChainExecutionResult) -> Option<String> {
    info_of(r)
        .and_then(|i| i.get("complianceLevel"))
        .and_then(|c| c.as_str())
        .map(str::to_string)
}

fn severity_of(r: &ChainExecutionResult) -> Option<Severity> {
    r.results
        .first()
        .and_then(|rec| rec.validation.as_ref())
        .and_then(|v| v.severity)
}

// ---- fixtures ---------------------------------------------------------------

const COMPLIANT: &str = "\
---
name: fallout-rpg
license: CC-BY-4.0
metadata:
  skill_author: Vault-Tec Archivists
  version: 1.2.0
  sources:
    - https://fallout.bethesda.net
  attribution: \"Derived from the Fallout community SRD.\"
  citations:
    - Fallout RPG Core Rulebook
---
# body
";

const PARTIAL: &str = "\
---
name: note-taker
metadata:
  skill_author: J. Doe
---
# body
";

// ---- grading ----------------------------------------------------------------

#[tokio::test]
async fn compliant_skill_grades_with_upstream() {
    let r = audit(read("skill://pkg/fallout-rpg/SKILL.md", Some(COMPLIANT))).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(
        compliance_of(&r).as_deref(),
        Some("compliant_with_upstream_attribution")
    );
    // Fully attributed → no messages → no severity.
    assert_eq!(severity_of(&r), None);
    // Audit tuple carries the fixed timestamp and skill identity.
    let info = info_of(&r).unwrap();
    assert_eq!(info["observedAt"], json!(FIXED_TS));
    assert_eq!(info["skill"]["name"], json!("fallout-rpg"));
}

#[tokio::test]
async fn partial_skill_warns_and_does_not_block() {
    let r = audit(read("skill://pkg/note-taker/SKILL.md", Some(PARTIAL))).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(compliance_of(&r).as_deref(), Some("partial"));
    assert_eq!(severity_of(&r), Some(Severity::Warn));
}

#[tokio::test]
async fn uncredited_skill_is_non_compliant_and_blocks() {
    let r = audit(read(
        "skill://pkg/mystery/SKILL.md",
        Some("# no frontmatter here"),
    ))
    .await;
    assert_eq!(r.status, ChainStatus::ValidationFailed);
    assert_eq!(r.aborts.len(), 1);
    assert_eq!(compliance_of(&r).as_deref(), Some("non-compliant"));
    assert_eq!(severity_of(&r), Some(Severity::Error));
}

#[tokio::test]
async fn missing_text_is_an_error() {
    let r = audit(read("skill://pkg/empty/SKILL.md", None)).await;
    assert_eq!(r.status, ChainStatus::ValidationFailed);
    assert_eq!(compliance_of(&r).as_deref(), Some("non-compliant"));
}

#[tokio::test]
async fn non_skill_uri_passes_through_without_audit() {
    let r = audit(read("skill://pkg/fallout-rpg/README.md", Some(COMPLIANT))).await;
    assert_eq!(r.status, ChainStatus::Success);
    assert_eq!(r.results.len(), 1);
    // No SKILL.md → no audit tuple emitted.
    assert!(info_of(&r).is_none());
}

// ---- field resolution -------------------------------------------------------

#[tokio::test]
async fn metadata_first_resolution_beats_top_level() {
    let text = "\
---
license: MIT
author: legacy-top-level
metadata:
  skill_author: canonical-metadata
---
# body
";
    let r = audit(read("skill://pkg/x/SKILL.md", Some(text))).await;
    let info = info_of(&r).unwrap();
    assert_eq!(info["attribution"]["author"], json!("canonical-metadata"));
}

#[tokio::test]
async fn layered_provenance_chain_counts_as_source() {
    // author + license + sources[] chain + attribution block, but NO scalar
    // `source` — must still grade as compliant_with_upstream (the bug the TS
    // port had to fix).
    let text = "\
---
license: Apache-2.0
metadata:
  skill_author: Someone
  sources:
    - https://upstream.example/skill
  attribution: \"Built on upstream.\"
---
# body
";
    let r = audit(read("skill://pkg/layered/SKILL.md", Some(text))).await;
    assert_eq!(
        compliance_of(&r).as_deref(),
        Some("compliant_with_upstream_attribution")
    );
}

#[tokio::test]
async fn null_field_falls_through_to_fallback_key() {
    // `metadata.skill_author` is explicitly null; the legacy `author` key must
    // still be credited — matching the TS `??` fall-through (not plain `.or_else`,
    // which only fires on an absent key).
    let text = "\
---
license: MIT
metadata:
  skill_author: null
  author: Legacy Name
  source: https://example.com/skill
---
# body
";
    let r = audit(read("skill://pkg/nullauthor/SKILL.md", Some(text))).await;
    let info = info_of(&r).unwrap();
    assert_eq!(info["attribution"]["author"], json!("Legacy Name"));
    // author + license + source, no upstream chain -> compliant.
    assert_eq!(compliance_of(&r).as_deref(), Some("compliant"));
}

#[tokio::test]
async fn empty_attribution_block_does_not_establish_provenance() {
    // A `sources[]` chain is present, but the `attribution` block is an empty
    // string — provenance is NOT established (mirrors TS `!!runtimeAttribution`).
    let text = "\
---
license: Apache-2.0
metadata:
  skill_author: Someone
  sources:
    - https://upstream.example/skill
  attribution: \"\"
---
# body
";
    let r = audit(read("skill://pkg/emptyattr/SKILL.md", Some(text))).await;
    // author + license, but no scalar source and an empty attribution block
    // -> has_source false -> partial (not compliant_with_upstream).
    assert_eq!(compliance_of(&r).as_deref(), Some("partial"));
}

#[tokio::test]
async fn scalar_source_without_chain_is_compliant_not_upstream() {
    let text = "\
---
license: Apache-2.0
metadata:
  skill_author: Someone
  source: https://example.com/skill
---
# body
";
    let r = audit(read("skill://pkg/scalar/SKILL.md", Some(text))).await;
    assert_eq!(compliance_of(&r).as_deref(), Some("compliant"));
}

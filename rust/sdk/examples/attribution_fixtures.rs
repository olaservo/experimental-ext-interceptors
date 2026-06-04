// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Self-contained skill-attribution demo — no external repos, no MCP client.
//!
//! Three inline `SKILL.md` fixtures (compliant / partial / uncredited) are
//! wrapped as `resources/read` result payloads and run through the interceptor
//! chain's response phase. The validator emits one `[skill-attribution]` JSON
//! event to stderr per read; this driver prints a human-readable summary to
//! stdout.
//!
//! Run: `cargo run --example attribution_fixtures`

use std::sync::Arc;

use mcp_ext_interceptors::{
    attribution::attribution_validator,
    chain::Chain,
    events::RESOURCES_READ,
    invocation::{FixedClock, InvocationContext, Principal},
};
use serde_json::{json, Map, Value};

/// A compliant skill: author + license + layered `sources[]` chain + an
/// `attribution` block → `compliant_with_upstream_attribution`.
const COMPLIANT: &str = "\
---
name: fallout-rpg
description: Fallout tabletop RPG helper
license: CC-BY-4.0
metadata:
  skill_author: Vault-Tec Archivists
  version: 1.2.0
  sources:
    - https://fallout.bethesda.net
    - https://falloutwiki.com
  attribution: \"Derived from the Fallout tabletop community SRD.\"
  citations:
    - Fallout RPG Core Rulebook
---
# Fallout RPG
Roll for initiative, vault dweller.
";

/// A partially-attributed skill: author only, no license or provenance →
/// `partial` (with a `warn` on the missing license).
const PARTIAL: &str = "\
---
name: note-taker
description: A simple note taker
metadata:
  skill_author: J. Doe
---
# Note Taker
Jot it down.
";

/// An uncredited skill: no YAML frontmatter at all → `non-compliant`, and an
/// `error` that blocks the chain (SEP-2640 conformance failure).
const UNCREDITED: &str = "\
# Mystery Tool
Does something, attributed to no one.
";

fn read_result(name: &str, text: &str) -> Value {
    json!({
        "contents": [{
            "uri": format!("skill://pkg/{name}/SKILL.md"),
            "mimeType": "text/markdown",
            "text": text,
        }]
    })
}

fn demo_context() -> InvocationContext {
    InvocationContext {
        principal: Some(Principal {
            principal_type: "user".to_string(),
            id: Some("gm@example.com".to_string()),
            claims: None,
        }),
        trace_id: Some("trace-fallout-session".to_string()),
        ..Default::default()
    }
}

#[tokio::main]
async fn main() {
    // Deterministic timestamp so the demo output is stable.
    let clock = Arc::new(FixedClock("2026-06-02T12:00:00Z".to_string()));
    let chain = Chain::new().with(attribution_validator(clock));

    let fixtures = [
        ("fallout-rpg", COMPLIANT),
        ("note-taker", PARTIAL),
        ("mystery-tool", UNCREDITED),
    ];

    println!("Skill-attribution interceptor — self-contained demo\n");

    for (name, text) in fixtures {
        let payload = read_result(name, text);
        let result = chain
            .execute_response(RESOURCES_READ, payload, Some(demo_context()))
            .await;

        let record = result.results.first();
        let info = record.and_then(|r| r.info.as_ref());
        let compliance = info
            .and_then(|i| i.get("complianceLevel"))
            .and_then(|c| c.as_str())
            .unwrap_or("(none)");
        let severity = record
            .and_then(|r| r.validation.as_ref())
            .and_then(|v| v.severity)
            .map(|s| format!("{s:?}").to_lowercase())
            .unwrap_or_else(|| "ok".to_string());

        println!("• {name}");
        println!("    complianceLevel : {compliance}");
        println!("    severity        : {severity}");
        println!("    chain status    : {:?}", result.status);
        if !result.aborts.is_empty() {
            for a in &result.aborts {
                println!("    BLOCKED by {}: {}", a.interceptor, a.reason);
            }
        }
        if let Some(attr) = info.and_then(|i| i.get("attribution")) {
            let attr = attr.as_object().cloned().unwrap_or_else(Map::new);
            if !attr.is_empty() {
                let keys: Vec<&String> = attr.keys().collect();
                println!("    attribution     : {keys:?}");
            }
        }
        println!();
    }

    println!(
        "(Per-read `[skill-attribution]` JSON events were written to stderr — \
         the seam an external ledger would tail.)"
    );
}

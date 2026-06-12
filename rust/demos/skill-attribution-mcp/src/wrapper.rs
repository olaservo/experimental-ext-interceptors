// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The client-side wrapper — the core of the demo. It connects an `rmcp` MCP
//! client to a backend skill server, lists `SKILL.md` resources, and runs each
//! `resources/read` response through the `mcp-ext-interceptors` chain. This is
//! the same in-process mount that Goose/Codex would use at their MCP-client
//! boundary: the wrapper **enforces** — it withholds content for a
//! non-compliant (uncredited) skill instead of returning it to the agent.

use std::sync::Arc;

use mcp_ext_interceptors::{
    attribution::attribution_validator,
    chain::Chain,
    events::RESOURCES_READ,
    invocation::{InvocationContext, Principal, SystemClock},
};
use rmcp::{
    model::ReadResourceRequestParams,
    service::RunningService,
    transport::{ConfigureCommandExt, TokioChildProcess},
    RoleClient, ServiceExt,
};
use tokio::process::Command;

type DemoResult = Result<(), Box<dyn std::error::Error>>;

/// Default location of the local fallout-helper MCP server (overridable via the
/// `FALLOUT_HELPER_DIR` env var, or a full `--fallout=<command>`).
const DEFAULT_FALLOUT_DIR: &str = "C:\\Users\\johnn\\OneDrive\\Documents\\GitHub\\skills-over-mcp-ig\\bellagio\\agent-skills-ttrpg-demo\\mcp\\fallout-helper";

/// The requester identity attached to every read (mirrors the TS demo's
/// `defaultContext`). In a real host this comes from the session's auth.
fn demo_context() -> InvocationContext {
    InvocationContext {
        principal: Some(Principal {
            principal_type: "user".to_string(),
            id: Some("demo-user@example.com".to_string()),
            claims: None,
        }),
        trace_id: Some("trace-attribution-demo".to_string()),
        ..Default::default()
    }
}

/// Run the demo against the bundled, self-contained fixture backend.
pub async fn run_fixture() -> DemoResult {
    println!("Skill-attribution MCP demo — fixture backend (self-contained)\n");
    let client = crate::fixture_backend::connect_fixture().await?;
    audit_skills(client).await
}

/// Run the demo against the real fallout-helper server (spawned over stdio).
pub async fn run_fallout(cmd_override: Option<String>) -> DemoResult {
    println!("Skill-attribution MCP demo — live fallout-helper backend\n");
    let client = connect_fallout(cmd_override).await?;
    audit_skills(client).await
}

/// Spawn the fallout-helper child process and connect an MCP client to its stdio.
async fn connect_fallout(
    cmd_override: Option<String>,
) -> Result<RunningService<RoleClient, ()>, Box<dyn std::error::Error>> {
    let dir =
        std::env::var("FALLOUT_HELPER_DIR").unwrap_or_else(|_| DEFAULT_FALLOUT_DIR.to_string());

    // Resolve (program, args). The default launches `bun main.ts --stdio`; on
    // Windows `bun` is commonly an npm shell-shim (no `bun.exe`), so go through
    // `cmd /c` to let PATH resolve `bun.cmd`. An explicit `--fallout=<command>`
    // overrides this (e.g. a prebuilt `node dist/index.js --stdio`). The backend
    // always runs with the fallout-helper directory as its working directory.
    let (program, args): (String, Vec<String>) = match cmd_override.filter(|s| !s.is_empty()) {
        Some(spec) => {
            let mut parts = spec.split_whitespace();
            let program = parts.next().ok_or("empty --fallout command")?.to_string();
            (program, parts.map(str::to_string).collect())
        }
        None if cfg!(windows) => (
            "cmd".to_string(),
            vec![
                "/c".into(),
                "bun".into(),
                "main.ts".into(),
                "--stdio".into(),
            ],
        ),
        None => ("bun".to_string(), vec!["main.ts".into(), "--stdio".into()]),
    };

    let transport = TokioChildProcess::new(Command::new(program).configure(|c| {
        c.args(&args).current_dir(&dir);
    }))?;
    let client = ().serve(transport).await?;
    Ok(client)
}

/// The backend-agnostic audit loop: list skills, read each, run the chain, and
/// present the verdict.
async fn audit_skills(client: RunningService<RoleClient, ()>) -> DemoResult {
    let chain = Chain::new().with(attribution_validator(Arc::new(SystemClock)));
    let ctx = demo_context();

    let resources = client.list_all_resources().await?;
    let skills: Vec<_> = resources
        .into_iter()
        .filter(|r| r.uri.ends_with("/SKILL.md"))
        .collect();
    println!("Found {} SKILL.md resource(s).\n", skills.len());

    let mut blocked = 0usize;
    for r in &skills {
        let uri = r.uri.clone();
        let result = client
            .read_resource(ReadResourceRequestParams::new(uri.clone()))
            .await?;

        // The rmcp read result serializes to `{ contents: [{ uri, text, .. }] }`
        // — exactly the shape the attribution validator reads.
        let payload = serde_json::to_value(&result)?;
        let bytes = payload
            .get("contents")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .map(str::len)
            .unwrap_or(0);

        let outcome = chain
            .execute_response(RESOURCES_READ, payload, Some(ctx.clone()))
            .await;

        let record = outcome.results.first();
        let compliance = record
            .and_then(|rec| rec.info.as_ref())
            .and_then(|i| i.get("complianceLevel"))
            .and_then(|c| c.as_str())
            .unwrap_or("(none)");
        let severity = record
            .and_then(|rec| rec.validation.as_ref())
            .and_then(|v| v.severity)
            .map(|s| format!("{s:?}").to_lowercase())
            .unwrap_or_else(|| "ok".to_string());

        println!("── {uri} ──");
        println!("    complianceLevel : {compliance}");
        println!("    severity        : {severity}");
        if outcome.ok() {
            println!("    read returned to agent ({bytes} bytes)");
        } else {
            blocked += 1;
            for a in &outcome.aborts {
                println!("    BLOCKED — content withheld from agent: {}", a.reason);
            }
        }
        println!();
    }

    println!(
        "Audited {} skill(s); {} blocked. Per-read `[skill-attribution]` JSON \
         events were emitted to stderr (the seam an external ledger tails).",
        skills.len(),
        blocked
    );

    let _ = client.cancel().await;
    Ok(())
}

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! A self-contained `rmcp` MCP server that serves three inline `SKILL.md`
//! resources — compliant, partial, and uncredited — so the demo has a real MCP
//! backend with no external dependencies. The skill bodies match the SDK's
//! `attribution_fixtures` example, so the grades come out identical.

use rmcp::{
    model::*, service::RequestContext, service::RunningService, ErrorData as McpError, RoleClient,
    RoleServer, ServerHandler, ServiceExt,
};
use serde_json::json;

/// A compliant skill: author + license + a layered `sources[]` chain backed by
/// an `attribution` block → `compliant_with_upstream_attribution`.
const COMPLIANT: &str = r#"---
name: fallout-rpg
description: Fallout tabletop RPG helper
license: CC-BY-4.0
metadata:
  skill_author: Vault-Tec Archivists
  version: 1.2.0
  sources:
    - https://fallout.bethesda.net
    - https://falloutwiki.com
  attribution: "Derived from the Fallout tabletop community SRD."
  citations:
    - Fallout RPG Core Rulebook
---
# Fallout RPG
Roll for initiative, vault dweller.
"#;

/// A partially-attributed skill: author only, no license or provenance →
/// `partial` (with a `warn` on the missing license).
const PARTIAL: &str = r#"---
name: note-taker
description: A simple note taker
metadata:
  skill_author: J. Doe
---
# Note Taker
Jot it down.
"#;

/// An uncredited skill: no YAML frontmatter at all → `non-compliant`, and an
/// `error` that blocks the chain (SEP-2640 conformance failure).
const UNCREDITED: &str = r#"# Mystery Tool
Does something, attributed to no one.
"#;

/// The skills this backend serves: `(name, SKILL.md body)`.
const SKILLS: &[(&str, &str)] = &[
    ("fallout-rpg", COMPLIANT),
    ("note-taker", PARTIAL),
    ("mystery-tool", UNCREDITED),
];

fn uri_for(name: &str) -> String {
    format!("skill://demo/{name}/SKILL.md")
}

/// The fixture MCP server.
#[derive(Clone)]
pub struct FixtureBackend;

impl ServerHandler for FixtureBackend {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_resources().build()).with_instructions(
            "Fixture skill backend serving three SKILL.md manifests.".to_string(),
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = SKILLS
            .iter()
            .map(|(name, _)| {
                RawResource::new(uri_for(name), format!("{name} skill manifest")).no_annotation()
            })
            .collect();
        Ok(ListResourcesResult {
            resources,
            next_cursor: None,
            meta: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        for (name, text) in SKILLS {
            if request.uri == uri_for(name) {
                return Ok(ReadResourceResult::new(vec![ResourceContents::text(
                    *text,
                    request.uri.clone(),
                )]));
            }
        }
        Err(McpError::resource_not_found(
            "resource_not_found",
            Some(json!({ "uri": request.uri })),
        ))
    }
}

/// Spin up the fixture backend on an in-memory transport and return a connected
/// MCP client wired to it — no child process, no stdio (robust on Windows).
pub async fn connect_fixture() -> Result<RunningService<RoleClient, ()>, Box<dyn std::error::Error>>
{
    let (server_transport, client_transport) = tokio::io::duplex(8192);

    tokio::spawn(async move {
        if let Ok(server) = FixtureBackend.serve(server_transport).await {
            let _ = server.waiting().await;
        }
    });

    let client = ().serve(client_transport).await?;
    Ok(client)
}

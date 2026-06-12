// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! Skill-attribution MCP demo — a client-side wrapper that audits skill
//! provenance over a real MCP connection.
//!
//! Usage:
//!   skill-attribution-mcp                       # bundled fixture backend (self-contained)
//!   skill-attribution-mcp --fallout             # spawn the local fallout-helper server
//!   skill-attribution-mcp --fallout="node dist/index.js --stdio"   # explicit backend command

mod fixture_backend;
mod wrapper;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().find(|a| a.starts_with("--fallout")) {
        Some(arg) => {
            let cmd = arg.strip_prefix("--fallout=").map(str::to_string);
            wrapper::run_fallout(cmd).await
        }
        None => wrapper::run_fixture().await,
    }
}

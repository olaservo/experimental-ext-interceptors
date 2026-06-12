# skill-attribution-mcp — demo

A **client-side MCP wrapper** that audits skill provenance over a real MCP
connection. It connects an [`rmcp`](https://crates.io/crates/rmcp) client to a
backend skill server, lists `SKILL.md` resources, and runs each `resources/read`
response through the `mcp-ext-interceptors` chain — the same in-process mount a
host like Goose or Codex would use at its MCP-client boundary.

The wrapper **enforces**: it prints the attribution audit tuple for every skill
and, for a non-compliant (uncredited) skill, **withholds the content** instead of
returning it to the agent.

This is the real-MCP counterpart to the SDK's self-contained
`attribution_fixtures` example (which runs the same chain with no MCP transport).

## Why a separate crate

The SDK crate (`mcp-ext-interceptors`) is deliberately **`rmcp`-free** so hosts
that depend on it don't inherit an MCP SDK. This demo isolates the `rmcp`
dependency in its own workspace member, keeping the library's dependency surface
and test loop clean.

## Run it

From the `rust/` workspace root:

```sh
# Self-contained: a bundled fixture backend serving 3 inline SKILL.md
cargo run -p skill-attribution-mcp
```

Expected: three skills graded `compliant_with_upstream_attribution` / `partial` /
`non-compliant`, with the uncredited one **BLOCKED — content withheld**. Per-read
`[skill-attribution]` JSON audit events go to **stderr**; the human-readable
summary goes to stdout.

### Against the real fallout-helper

```sh
# Default: spawns `bun main.ts --stdio` in the local fallout-helper directory
cargo run -p skill-attribution-mcp -- --fallout

# Override the directory:
FALLOUT_HELPER_DIR=/path/to/fallout-helper cargo run -p skill-attribution-mcp -- --fallout

# Or give an explicit backend command (e.g. a prebuilt Node bundle):
cargo run -p skill-attribution-mcp -- --fallout="node dist/index.js --stdio"
```

The fallout-helper server must be runnable first (`bun install` in its
directory). This mode reads the real Fallout skill set: the credited skills grade
`compliant_with_upstream_attribution`, and `fallout-uncredited-encounters` is
caught as `non-compliant`. Note it is *graded* non-compliant but **not blocked** —
it has frontmatter (just no attribution), and only a *missing-frontmatter* read
(severity `error`, like the fixture's `mystery-tool`) blocks. "Non-compliant" is a
verdict; "blocked" is an enforcement action. This mode is **not** run in CI (the
fixture mode is).

> On Windows, stdio child processes can be slow to close after output; the run is
> correct — stop the process once the summary prints if it lingers.

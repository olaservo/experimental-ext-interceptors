# MCP Interceptors — Rust SDK

> **Status:** Experimental. Prototyping and feedback only — not an accepted or
> official MCP extension.

A Rust implementation of the MCP Interceptors extension
([SEP-2624](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1763)),
and the third independent implementation after the TypeScript and C# SDKs.

## Scope

This crate implements the SEP-2624 **execution model**, run entirely in-process
as the SDK "convenience utility" the spec describes — a validator/mutator
[`Chain`] mounted at a host's MCP-client boundary. It does not implement the
JSON-RPC wire methods or a gateway (see conformance below).

### Source of truth

The types track the **canonical SEP-2624 PR**
([`modelcontextprotocol/modelcontextprotocol#2624`](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2624)):
`mode` is `active | audit` (default `active`) and an interceptor declares a
`hooks` array of `{ events, phase }` entries. Note: this repo's checked-in
`docs/sep.md` is an *edited* copy that diverges (`enforce`/`audit`, a single
`hook` with `phase: both`, `*/request` wildcards), and the in-repo **Go SDK**
follows that copy. This crate intentionally tracks the upstream PR.

## SEP-2624 conformance

**Implemented** (the execution model, per the spec's "Execution Model" section,
which MUST be followed by all implementations):

- Interceptor metadata — `name`, `version`, `description`, `type`
  (`validation | mutation`), `hooks: [{events, phase}]`, `mode`
  (`active | audit`), `failOpen`, `priorityHint` (`number | {request, response}`),
  `compat`, `configSchema`.
- `ValidationResult` (`valid`, `severity`, `messages`, `suggestions`) and
  `MutationResult` (`modified`, `payload`, `info`), serialized **flat** as in the
  spec's `interceptor/invoke` result.
- Trust-boundary-aware ordering — sending: mutate → validate; receiving:
  validate → mutate.
- Validations **parallel**; mutations **sequential** by `priorityHint`
  (alphabetical tie-break) and **atomic** (whole chain applies or none).
- Severity gating (only `error` blocks), **audit** mode (never blocks; mutators
  shadow-compute without applying), **`failOpen`** (proceed past throws/timeouts),
  per-interceptor timeouts.
- Events incl. the `"*"` wildcard and `"ns/*"` namespace wildcards (a spec MAY).
- Invocation context — `principal`, `traceId`, `spanId`, `timestamp`, `sessionId`.

**Not implemented** (deferred):

- The JSON-RPC wire methods `interceptors/list` and `interceptor/invoke`.
- The `capabilities.interceptor` advertisement on `initialize`.
- The wire error codes `-32000` / `-32602` / `-32603` (a throwing/timed-out
  interceptor surfaces in-process as an abort with an `error` on its record).
- A transparent gateway / client-wrapper that speaks the wire methods.
- The reserved-for-future validation `signature` field.

A host that mounts interceptors in-process at its MCP-client boundary needs only
the implemented set; the deferred items are required only when interceptors live
in a separate process.

## Mounting at the client boundary

The [`mount`] API is JSON-only and free of any MCP-SDK (`rmcp`) types, so the
same interceptor runs unchanged inside Goose, a Codex fork, or a gateway. A host
adapts its native `resources/read` result into a `serde_json::Value`, then:

```rust
use std::sync::Arc;
use mcp_ext_interceptors::{
    attribution::attribution_validator, chain::Chain,
    events::RESOURCES_READ, invocation::SystemClock,
};

let chain = Chain::new().with(attribution_validator(Arc::new(SystemClock)));
let result = chain.execute_response(RESOURCES_READ, payload, context).await;
if !result.ok() {
    // a validator blocked the read — see result.aborts
}
// audit records are on result.results[*].info
```

## The skill-attribution validator

The flagship interceptor audits SEP-2640 `SKILL.md` frontmatter on
`resources/read` (response phase):

- recognises `…/SKILL.md` URIs and parses the YAML frontmatter,
- resolves attribution fields **metadata-first** (per the Agent Skills spec),
  falling back to top-level for legacy files,
- grades provenance into four tiers
  (`compliant_with_upstream_attribution` / `compliant` / `partial` /
  `non-compliant`), crediting either a scalar `source` URL **or** a populated
  `sources[]` chain backed by an `attribution` block,
- missing `author`/`license` → `warn`; missing frontmatter → `error` (blocks),
- emits a `{ skill, attribution, requester, traceId, observedAt,
  complianceLevel }` tuple onto the result `info` field and as a one-line JSON
  `[skill-attribution]` event on stderr.

## Build, test, demo

```sh
cargo build
cargo test
cargo run --example attribution_fixtures   # 3 bundled fixtures end-to-end
```

The example prints `compliant_with_upstream_attribution` / `partial` /
`non-compliant` for the three fixtures and demonstrates the uncredited skill
being blocked.

## License

Apache-2.0.

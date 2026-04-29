# Layered attribution demo

A four-fixture walkthrough that exercises every compliance level the gateway emits — including `compliant_with_upstream_attribution`, the level that fires only when a skill carries a non-empty `derived_from` chain.

The four fixtures are the real Fallout TTRPG skills shipped in `agent-skills-ttrpg-demo/mcp/fallout-helper/skills/fallout-ttrpg/`. The smoke test at `smoke-test.mjs` mirrors their frontmatter inline and asserts the expected `complianceLevel` and chain shape for each, so it doubles as the executable spec for what follows.

## What the audience sees

Four `resources/read` calls in sequence. One audit record scrolls past for each:

1. **`fallout-rpg`** — `compliant_with_upstream_attribution`. One-deep chain crediting Modiphius for the system. The straightforward case: original encoding of licensed mechanics.
2. **`fallout-machine-frequency`** — `compliant_with_upstream_attribution`. Two-deep chain crediting Modiphius for *both* the system and the specific adventure module. The murky-rights case: the chain is what makes the rights claim explicit and traceable.
3. **`fallout-character-sheets`** — `compliant_with_upstream_attribution`. Two-deep chain crediting Modiphius for the system and the author's own `fallout-rpg` skill for the system encoding. The canonical creator case: original creative work using a licensed substrate.
4. **`fallout-uncredited-encounters`** — `non-compliant`. No author, no license, no chain. The gateway visibly catches what's missing.

## Why the contrast matters

Fixtures 2 and 3 have the same chain *depth* (two upstreams) and overlap on publisher (Modiphius appears in both), but their rights stories are fundamentally different:

| | fixture 2 (machine-frequency) | fixture 3 (character-sheets) |
|---|---|---|
| What's encoded | A specific published Modiphius adventure module | Six original PCs the author wrote |
| Second `derived_from` entry | Modiphius's adventure module (`relationship: adventure`, `license: proprietary`) | The author's own `fallout-rpg` skill (`relationship: system_encoding`, `license: CC-BY-4.0`) |
| If a marketplace surfaced this skill | Modiphius's commercial interest in the adventure is at stake | The author's authorial credit is at stake |
| Skill-level license | `CC-BY-NC-SA-4.0` (NC reflects upstream commercial sensitivity) | `CC-BY-4.0` (no NC; the only proprietary upstream is the system itself) |

A downstream marketplace, compliance system, or compensation router that treated these two skills identically would do real harm in either direction. The substrate has to make the distinction expressible — it does, via `relationship` and per-entry `license` fields. The gateway's job is to surface that data verbatim. **What downstream tooling does with it is a separate problem this gateway deliberately doesn't solve.**

## Running the demo

The smoke test executes the same four reads with assertions:

```bash
npm start &           # in one shell
node smoke-test.mjs   # in another
```

Audit records land on stderr in real time, in the order above (preceded by three legacy fixtures that exercise the lower compliance levels). The final line is `skill-attribution smoke-test OK`.

For a manual walkthrough, point any MCP client at the gateway and read the four `SKILL.md` URIs in order — the `[skill-attribution] {…}` lines on stderr are the demo.

## Tailing the audit ledger

Each `resources/read` lands one JSON line on stderr, prefixed `[skill-attribution]`. The prefix exists so a downstream filter can pick those lines out without having to parse structured logs.

The simplest durable ledger is a JSONL file via stderr redirect:

```bash
npm start 2> audit.jsonl
```

For a live pretty-printed scroll *and* a clean JSONL file at once:

```bash
npm start 2>&1 >/dev/null \
  | grep '^\[skill-attribution\]' \
  | sed 's/^\[skill-attribution\] //' \
  | tee audit.jsonl \
  | jq .
```

Useful one-liners against `audit.jsonl`:

```bash
# Every non-compliant read
jq 'select(.complianceLevel == "non-compliant")' audit.jsonl

# Compact chain-shape projection (skill + level + chain depth)
jq '{skill: .skill.name, level: .complianceLevel, depth: (.attribution.derived_from // [] | length)}' audit.jsonl

# Just the layered cases
jq 'select(.complianceLevel == "compliant_with_upstream_attribution") | {skill: .skill.name, chain: [.attribution.derived_from[].relationship]}' audit.jsonl
```

A real deployment would replace the file with a proper collector (SQLite, OTLP, S3, the auditing system of your choice) — but for a demo on short notice, JSONL + `jq` plays better than wiring up a SQL prompt or a network sink that can fail in front of an audience.

## What this demo deliberately does not show

For honesty when fielding questions:

- **License-cascade math.** The gateway does not compute "given this chain of licenses, what can the resulting work be released under." That's a real problem; it's not this demo's problem.
- **Controlled vocabularies for `relationship` and `rights_basis`.** The fixtures use plausible values, but the gateway treats them as opaque strings. Standardizing the vocabulary is WG work — and the contrast between fixtures 2 and 3 is designed to make it obvious *why* it would need standardizing.
- **Signature verification.** Attribution is an assertion; the gateway makes it visible but doesn't prove it. SEP-2624's `signature` field is reserved for future use.
- **Chain integrity.** A skill that lies about its `derived_from` ancestors will pass the gateway. Detecting that requires upstream skills to be fetchable and verifiable, which is its own infrastructure problem.
- **Marketplace surfacing.** The gateway emits the join key downstream tooling would consume. It does not consume that data itself.

The framing: the gateway makes attribution chains *visible* and *auditable*. It does not make them *trustworthy* or *enforceable*. Visibility alone is useful — it is what HTTP middleware cannot ship, what `_meta` cannot ship, what the agentskills.io discovery RFC does not yet ship.

# Skill Attribution Gateway

A single-interceptor sample that sits between an agent and any [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) skill server, validates that each `SKILL.md` carries the attribution metadata it ought to, and emits a per-read audit record combining **what was read** with **who read it**.

## What it does

For every `resources/read` whose URI ends in `/SKILL.md`, the gateway:

1. Parses the YAML frontmatter from the response body.
2. Checks for the attribution fields below and reports what's missing as validation messages.
3. Emits a structured audit record combining the skill identity (URI, name, declared author) with the requester identity (`context.principal`).
4. Returns `valid: true` for non-blocking gaps so working skills aren't broken — only a missing/malformed frontmatter `error`s. Hosts that prefer hard enforcement can configure their gateway to treat `warn` as blocking.

## When you might want this

- **Organisations with a skill compliance policy** — auditors need a record of which skills were used, when, by whom, and whether they declared an author/license. The interceptor produces that record at the chokepoint without modifying the skill server.
- **Operators of multi-tenant skill catalogues** — when you proxy multiple upstream skill servers and want a single chokepoint that audits attribution and emits a normalised audit stream, without having to chase down every upstream to fix non-compliant skills.
- **Hosts that can't be modified** — Claude Desktop, Cursor, IDE plugins, etc. don't surface attribution natively. A gateway in front of the skill server is a way to attach the behavior without touching the host.
- **A research seam for downstream tooling** — the audit records are the data any future compensation, marketplace-feedback, or popularity-ranking system would consume. Building those systems is out of scope here; producing the data they'd need is the point.

## What gets validated

The interceptor fires on `resources/read` **response** phase for any URI ending in `/SKILL.md` (per SEP-2640's URI shape). It parses YAML frontmatter and checks:

| Frontmatter field | If missing | Severity |
|---|---|---|
| `skill_author` (or legacy `author`) | "credit can't be assigned" | `warn` |
| `license` | "reuse rights unclear" | `warn` |
| `source` / `homepage` / `repository` | "provenance unverifiable" | `info` |
| `citations` / `references` | "outside material unattributed" | `info` |
| `version` | "reproducibility harder" | `info` |
| `sources` (or legacy `derived_from`) | "upstream chain undeclared" | `info` |
| _(no frontmatter at all)_ | "fails SEP-2640 conformance" | `error` |

Per SEP-2624, only `error` blocks the chain. `warn` and `info` are non-blocking by default.

The validator also reads three layered-attribution fields and surfaces them verbatim in the audit record (without grading them):

- `attribution` — a multi-line string hosts SHOULD render at session start; emitted as `attribution.runtime_attribution`.
- `depends_on` — sibling skills this skill composes with at runtime.
- `own_contributions` — original creative work that coexists with declared derivation.

The compliance level reported on each read is one of:

- `compliant_with_upstream_attribution` — `compliant` plus a non-empty `sources` chain (legacy `derived_from` also accepted)
- `compliant` — author + license + source all present
- `partial` — author and/or license present
- `non-compliant` — neither author nor license present

## The audit record

For every skill `resources/read` the validator passes through, it emits a one-line JSON event to stderr:

```json
{
  "skill":           { "uri": "skill://olaservo/fallout-helper/fallout-character-sheets/SKILL.md", "name": "fallout-character-sheets" },
  "attribution": {
    "author":  { "name": "Ola Hungerford", "url": "https://github.com/olaservo" },
    "license": "CC-BY-4.0",
    "source":  "https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-character-sheets",
    "version": "1.0.0",
    "sources": [
      {
        "title":        "fallout-rpg (sibling skill)",
        "publisher":    "Ola Hungerford",
        "url":          "https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg",
        "relationship": "system_encoding",
        "rights_basis": "license_grant",
        "license":      "CC-BY-4.0",
        "covers":       "2d20 mechanics (S.P.E.C.I.A.L., skills, perks, AP, Luck, combat resolution)"
      },
      {
        "title":        "Fallout: The Roleplaying Game (Core Rulebook)",
        "publisher":    "Modiphius Entertainment",
        "ip_holder":    "Bethesda Softworks",
        "year":         2021,
        "url":          "https://www.modiphius.net/products/fallout-the-roleplaying-game",
        "relationship": "trademark_setting_vocabulary",
        "rights_basis": "fair_use_claim",
        "covers":       "Fallout-universe origins and trademark terms used in pregen backgrounds"
      }
    ],
    "runtime_attribution": "Six pre-generated player characters by Ola Hungerford, licensed CC-BY-4.0...",
    "depends_on":         ["fallout-rpg"],
    "own_contributions":  [
      "Six original pre-generated player characters with full sheets, biographies, and inventories",
      "Picker logic for matching players to characters by play style",
      "Composition guidance for pairing the party with the fallout-machine-frequency adventure"
    ]
  },
  "requester":       { "type": "user", "id": "alice@example.com" },
  "traceId":         "trace-...",
  "observedAt":      "2026-04-27T...",
  "complianceLevel": "compliant_with_upstream_attribution"
}
```

The same record is also returned in the SEP-2624 validation result's `info` field, so callers who don't want to scrape stderr can read it from the chain result directly.

This `(skill, attribution, requester, observedAt)` tuple is the join key. It's what any downstream system would need to:

- attribute usage back to skill authors (group by `attribution.author`)
- report on which agents/users used which skills (group by `requester`, filter by `skill.uri`)
- audit non-compliance ("show me every skill read with `complianceLevel != compliant`, filtered by `requester.claims.org`")

The gateway doesn't build any of those. It produces the record they'd consume.

## Run

```bash
npm install
npm run build
npm start                              # http://localhost:39818/mcp
node dist/index.js --port=4000         # custom port
node dist/index.js --port=4000 --path=/api/mcp
```

Or directly via tsx (no build step):

```bash
npm run dev
```

Smoke test (covers all four compliance levels, including the layered TTRPG fixtures, plus an `InterceptingClient`-wrapped backend) against a running gateway. See [`layered-attribution-demo.md`](./layered-attribution-demo.md) for the demo walkthrough the smoke test mirrors.

```bash
npm start &                # in one shell
node smoke-test.mjs        # in another (default http://localhost:39818/mcp)
```

Audit records land on stderr in real time as the test reads each fixture skill.

## Where the requester comes from

The validator reads `context.principal` from the `interceptor/invoke` request. Two paths to populate it:

1. **Direct chain calls** pass `params.context.principal` explicitly:
   ```ts
   await executeRemoteChain([interceptorClient], {
     event: 'resources/read',
     phase: 'response',
     payload: readResult,
     context: { principal: { type: 'user', id: 'alice@example.com' } },
   });
   ```
2. **`InterceptingClient`** accepts `defaultContext` at construction:
   ```ts
   new InterceptingClient(backendClient, {
     interceptorClient,
     defaultContext: { principal: { type: 'user', id: 'alice@example.com' } },
   });
   ```

In a deployed setup the principal would come from auth on the host's incoming request and be threaded down. For the demo, it's set explicitly.

## Honest limits

- **Trust**: any party between a host and a skill server can claim "this skill is authored by X." The gateway makes the assertion visible; it doesn't prove it. Cryptographic provenance needs SEP-2624's `signature` field, still reserved for future use.
- **Enforcement**: the validator only reports. Hosts can ignore `warn`/`info` results entirely. Hard enforcement requires either (a) the gateway treating `warn` as blocking, or (b) host-side UI conventions that surface compliance levels.
- **One read at a time**: a skill that itself invokes other skills doesn't get composite attribution from this validator. End-to-end provenance through skill chains needs request correlation that doesn't exist yet.

## Why frontmatter, not `_meta`

The validator reads YAML frontmatter rather than `_meta` because skill-level metadata (author, license, version) belongs in frontmatter per the [skills `_meta` keys recommendations](https://github.com/modelcontextprotocol/experimental-ext-skills/blob/main/docs/skill-meta-keys.md) proposed by the Skills Over MCP Working Group.

## SEP relationship

- **SEP-2640** (Skills Extension) defines the `skill://` resource convention this validator hooks into.
- **SEP-2624** (Interceptors) defines the `interceptors/list` + `interceptor/invoke` JSON-RPC surface and the validation result shape (`valid`, `severity`, `messages`, `info`) we return.

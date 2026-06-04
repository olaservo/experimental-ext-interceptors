// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The skill-attribution validator: a single SEP-2624 validation interceptor on
//! `resources/read` (response phase) that audits SEP-2640 `SKILL.md` frontmatter
//! for attribution and records a per-read `[skill-attribution]` audit tuple.
//!
//! Ported from the TypeScript reference
//! (`examples/skill-attribution/src/interceptors.ts`). The attribution / grading
//! / audit-tuple logic is preserved; only the SDK wiring is Rust-native.

mod frontmatter;
mod grade;

pub use frontmatter::{metadata_field, parse_frontmatter};
pub use grade::{ComplianceInputs, ComplianceLevel};

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use crate::interceptor::{Interceptor, InterceptorError};
use crate::invocation::{Invocation, SharedClock, SystemClock};
use crate::types::{
    InterceptorType, InvokeOutput, Metadata, Phase, Severity, ValidationMessage, ValidationResult,
};
use frontmatter::{field_truthy, nonempty_array, present};

/// The interceptor name advertised in metadata and audit records.
pub const NAME: &str = "skill-attribution-validator";

/// A validation interceptor that audits skill attribution on `resources/read`.
pub struct AttributionValidator {
    metadata: Metadata,
    clock: SharedClock,
}

impl AttributionValidator {
    /// Build the validator with a custom [`crate::invocation::Clock`].
    pub fn new(clock: SharedClock) -> Self {
        let mut metadata = Metadata::new(
            NAME,
            InterceptorType::Validation,
            vec![crate::events::RESOURCES_READ.to_string()],
            Phase::Response,
        );
        metadata.description = Some(
            "Validates SEP-2640 skill manifests carry attribution (skill_author, \
             license, source, sources[]) and records a (skill, author, requester, ts) \
             audit tuple."
                .to_string(),
        );
        AttributionValidator { metadata, clock }
    }
}

impl Default for AttributionValidator {
    fn default() -> Self {
        AttributionValidator::new(Arc::new(SystemClock))
    }
}

/// Convenience constructor returning a ready-to-register interceptor.
pub fn attribution_validator(clock: SharedClock) -> Arc<dyn Interceptor> {
    Arc::new(AttributionValidator::new(clock))
}

#[async_trait]
impl Interceptor for AttributionValidator {
    fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    async fn invoke(&self, invocation: &Invocation) -> Result<InvokeOutput, InterceptorError> {
        // Pull the first content's URI out of the read response.
        let first = invocation
            .payload
            .get("contents")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first());
        let uri = first.and_then(|c| c.get("uri")).and_then(|u| u.as_str());

        // Only opine on SKILL.md reads; everything else passes through silently.
        let uri = match uri {
            Some(u) if is_skill_manifest(u) => u,
            _ => return Ok(InvokeOutput::validation(ValidationResult::success())),
        };

        let observed_at = self.clock.now_rfc3339();
        let skill_name = skill_name_from_uri(uri);
        let mut messages: Vec<ValidationMessage> = Vec::new();
        let mut attribution = Map::new();
        let mut compliance = ComplianceLevel::NonCompliant;

        match first.and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
            None => messages.push(ValidationMessage {
                path: Some("$.contents[0].text".to_string()),
                message: "SKILL.md resource has no text content to inspect.".to_string(),
                severity: Severity::Error,
            }),
            Some(text) => match parse_frontmatter(text) {
                None => messages.push(ValidationMessage {
                    path: Some("$.contents[0].text".to_string()),
                    message: "SKILL.md does not begin with valid YAML frontmatter \
                              (per SEP-2640 / Agent Skills spec)."
                        .to_string(),
                    severity: Severity::Error,
                }),
                Some(fm) => {
                    compliance = inspect_frontmatter(&fm, &mut attribution, &mut messages);
                }
            },
        }

        // Build the audit tuple combining skill identity + requester context.
        let requester = invocation
            .context
            .as_ref()
            .and_then(|c| c.principal.as_ref())
            .and_then(|p| serde_json::to_value(p).ok());
        let trace_id = invocation.context.as_ref().and_then(|c| c.trace_id.clone());

        let mut skill = Map::new();
        skill.insert("uri".to_string(), json!(uri));
        if let Some(name) = &skill_name {
            skill.insert("name".to_string(), json!(name));
        }

        let mut tuple = Map::new();
        tuple.insert("skill".to_string(), Value::Object(skill));
        tuple.insert("attribution".to_string(), Value::Object(attribution));
        if let Some(req) = requester {
            tuple.insert("requester".to_string(), req);
        }
        if let Some(tid) = trace_id {
            tuple.insert("traceId".to_string(), json!(tid));
        }
        tuple.insert("observedAt".to_string(), json!(observed_at));
        tuple.insert(
            "complianceLevel".to_string(),
            serde_json::to_value(compliance).unwrap_or(Value::Null),
        );
        let tuple = Value::Object(tuple);

        // One-line JSON event on stderr — the seam an external ledger tails.
        eprintln!(
            "[skill-attribution] {}",
            serde_json::to_string(&tuple).unwrap_or_default()
        );

        let has_error = messages.iter().any(|m| m.severity == Severity::Error);
        let severity = if has_error {
            Some(Severity::Error)
        } else if messages.iter().any(|m| m.severity == Severity::Warn) {
            Some(Severity::Warn)
        } else if !messages.is_empty() {
            Some(Severity::Info)
        } else {
            None
        };

        Ok(InvokeOutput::validation(ValidationResult {
            valid: !has_error,
            severity,
            messages,
            suggestions: vec![],
        })
        .with_info(tuple))
    }
}

/// Resolve attribution fields from frontmatter, push the per-field messages, and
/// return the compliance grade. Populates `attribution` with the resolved tuple.
fn inspect_frontmatter(
    fm: &Value,
    attribution: &mut Map<String, Value>,
    messages: &mut Vec<ValidationMessage>,
) -> ComplianceLevel {
    // Cross-key fallbacks use `present(...)` so a present-but-null field falls
    // through to the next key, matching the TS reference's `??` (nullish) chains.
    // Author: layered `skill_author`, falling back to legacy `author`.
    let author = present(metadata_field(fm, "skill_author"))
        .or_else(|| present(metadata_field(fm, "author")));
    // Upstream chain: `sources[]`, falling back to legacy `derived_from[]`.
    let chain = nonempty_array(metadata_field(fm, "sources"))
        .or_else(|| nonempty_array(metadata_field(fm, "derived_from")));
    // Freeform `attribution` block (only counts when it's a string).
    let runtime_attribution = metadata_field(fm, "attribution").and_then(|v| v.as_str());
    let depends_on = nonempty_array(metadata_field(fm, "depends_on"));
    let own_contributions = nonempty_array(metadata_field(fm, "own_contributions"));
    let source_url = present(metadata_field(fm, "source"))
        .or_else(|| present(metadata_field(fm, "homepage")))
        .or_else(|| present(metadata_field(fm, "repository")));
    let citations = present(metadata_field(fm, "citations"))
        .or_else(|| present(metadata_field(fm, "references")));
    let version = metadata_field(fm, "version");
    let license = fm.get("license"); // recognised top-level field

    // Assemble the attribution record (omit absent fields, matching JSON.stringify).
    insert_some(attribution, "author", author);
    insert_some(attribution, "license", license);
    insert_some(attribution, "source", source_url);
    insert_some(attribution, "citations", citations);
    insert_some(attribution, "version", version);
    if let Some(c) = chain {
        attribution.insert("sources".to_string(), Value::Array(c.clone()));
    }
    if let Some(ra) = runtime_attribution {
        attribution.insert("runtime_attribution".to_string(), json!(ra));
    }
    if let Some(d) = depends_on {
        attribution.insert("depends_on".to_string(), Value::Array(d.clone()));
    }
    if let Some(o) = own_contributions {
        attribution.insert("own_contributions".to_string(), Value::Array(o.clone()));
    }

    let has_author = field_truthy(author);
    let has_license = field_truthy(license);
    let has_chain = chain.is_some();
    // Provenance: scalar source URL, OR a populated chain backed by a non-empty
    // `attribution` block. The emptiness check mirrors the TS `!!runtimeAttribution`
    // (an `attribution: ""` does not establish provenance).
    let has_source = field_truthy(source_url)
        || (has_chain && runtime_attribution.is_some_and(|s| !s.is_empty()));

    if !has_author {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.metadata.skill_author".to_string()),
            message: "Skill is missing `skill_author` (or legacy `author`) — \
                      attribution credit cannot be assigned."
                .to_string(),
            severity: Severity::Warn,
        });
    }
    if !has_license {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.license".to_string()),
            message: "Skill is missing `license` — reuse and redistribution rights are unclear."
                .to_string(),
            severity: Severity::Warn,
        });
    }
    if !has_source {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.metadata.source".to_string()),
            message: "Skill declares no provenance — needs a `source` / `homepage` / \
                      `repository` URL or a `sources[]` chain plus an `attribution` block."
                .to_string(),
            severity: Severity::Info,
        });
    }
    if !field_truthy(citations) {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.metadata.citations".to_string()),
            message: "Skill declares no `citations` / `references` — outside material is \
                      unattributed."
                .to_string(),
            severity: Severity::Info,
        });
    }
    if !field_truthy(version) {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.metadata.version".to_string()),
            message: "Skill is missing `version` — reproducibility is harder.".to_string(),
            severity: Severity::Info,
        });
    }
    if !has_chain {
        messages.push(ValidationMessage {
            path: Some("$.frontmatter.metadata.sources".to_string()),
            message: "Skill declares no `sources` (or legacy `derived_from`) — upstream \
                      chain undeclared."
                .to_string(),
            severity: Severity::Info,
        });
    }

    ComplianceInputs {
        has_author,
        has_license,
        has_source,
        has_chain,
    }
    .grade()
}

fn insert_some(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(v) = value {
        // Mirror JSON.stringify dropping `undefined`: a present-but-null field
        // is still omitted here (the TS object holds `undefined`, not `null`).
        if !v.is_null() {
            map.insert(key.to_string(), v.clone());
        }
    }
}

/// Recognise a SEP-2640 skill manifest by URI: any `scheme://…/SKILL.md`
/// (covers the canonical `skill://` scheme and native schemes like
/// `github://owner/repo/skills/<name>/SKILL.md`).
fn is_skill_manifest(uri: &str) -> bool {
    uri.ends_with("/SKILL.md") && has_uri_scheme(uri)
}

fn has_uri_scheme(uri: &str) -> bool {
    match uri.find("://") {
        Some(pos) if pos > 0 => {
            let scheme = &uri[..pos];
            let mut chars = scheme.chars();
            let first = chars.next().unwrap();
            first.is_ascii_alphabetic()
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        }
        _ => false,
    }
}

/// The final path segment before `/SKILL.md` is the skill name per SEP-2640.
fn skill_name_from_uri(uri: &str) -> Option<String> {
    let stem = uri.strip_suffix("/SKILL.md")?;
    stem.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_skill_uris() {
        assert!(is_skill_manifest("skill://pkg/fallout-rpg/SKILL.md"));
        assert!(is_skill_manifest("github://owner/repo/skills/foo/SKILL.md"));
        assert!(!is_skill_manifest("skill://pkg/fallout-rpg/README.md"));
        assert!(!is_skill_manifest("/local/path/SKILL.md"));
    }

    #[test]
    fn extracts_skill_name() {
        assert_eq!(
            skill_name_from_uri("skill://pkg/fallout-rpg/SKILL.md").as_deref(),
            Some("fallout-rpg")
        );
        assert_eq!(
            skill_name_from_uri("skill://fallout-rpg/SKILL.md").as_deref(),
            Some("fallout-rpg")
        );
    }
}

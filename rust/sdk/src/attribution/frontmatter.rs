// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! YAML frontmatter extraction and SEP-2640 metadata-first field resolution.
//!
//! Ported from the TypeScript reference
//! (`examples/skill-attribution/src/interceptors.ts`).

use serde_json::Value;

/// Extract the YAML frontmatter object from a `SKILL.md` body. Returns `None`
/// if the document doesn't open with a `---` fence, the fence isn't closed, the
/// YAML is malformed, or it doesn't parse to a mapping.
pub fn parse_frontmatter(text: &str) -> Option<Value> {
    if !text.starts_with("---") {
        return None;
    }
    // Find the closing `\n---` fence after the opening one.
    let end = text[3..].find("\n---")? + 3;
    let block = text[3..end].trim();
    match serde_yaml_ng::from_str::<Value>(block) {
        Ok(value) if value.is_object() => Some(value),
        _ => None,
    }
}

/// Resolve a custom frontmatter field per the Agent Skills spec: only `name`,
/// `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`
/// are recognised at the top level; everything else lives under `metadata`.
///
/// Checks `metadata` first (returning its value even when present-but-null, to
/// match the TypeScript `!== undefined` semantics), then falls back to the top
/// level for legacy SKILL.md files that haven't migrated.
pub fn metadata_field<'a>(fm: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(md) = fm.get("metadata").and_then(|m| m.as_object()) {
        if let Some(v) = md.get(key) {
            return Some(v);
        }
    }
    fm.get(key)
}

/// JavaScript-style truthiness for a JSON value: `null`, `false`, `0`, and the
/// empty string are falsy; everything else (objects, arrays — even empty — and
/// non-empty scalars) is truthy. Mirrors the TS `!!value` checks.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// True if `field` resolves to a present, truthy value.
pub fn field_truthy(field: Option<&Value>) -> bool {
    field.map(is_truthy).unwrap_or(false)
}

/// Resolve a field to a populated array (length > 0), or `None`.
pub fn nonempty_array(field: Option<&Value>) -> Option<&Vec<Value>> {
    field.and_then(|v| v.as_array()).filter(|a| !a.is_empty())
}

/// Treat a present-but-`null` field as absent. Used so `.or_else(...)` fallback
/// chains over alternative keys behave like JavaScript's `??` (nullish)
/// coalescing in the TypeScript reference, which falls through on `null` — not
/// just on an absent key.
pub fn present(field: Option<&Value>) -> Option<&Value> {
    field.filter(|v| !v.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_fence_is_none() {
        assert!(parse_frontmatter("# just markdown").is_none());
    }

    #[test]
    fn unclosed_fence_is_none() {
        assert!(parse_frontmatter("---\nname: x\n").is_none());
    }

    #[test]
    fn parses_basic_frontmatter() {
        let fm = parse_frontmatter("---\nname: foo\nlicense: MIT\n---\nbody").unwrap();
        assert_eq!(fm.get("name").unwrap(), "foo");
        assert_eq!(fm.get("license").unwrap(), "MIT");
    }

    #[test]
    fn metadata_first_resolution() {
        let fm = json!({
            "metadata": { "skill_author": "Vault-Tec" },
            "skill_author": "legacy"
        });
        assert_eq!(metadata_field(&fm, "skill_author").unwrap(), "Vault-Tec");
    }

    #[test]
    fn falls_back_to_top_level() {
        let fm = json!({ "author": "legacy" });
        assert_eq!(metadata_field(&fm, "author").unwrap(), "legacy");
    }

    #[test]
    fn truthiness() {
        assert!(!is_truthy(&json!("")));
        assert!(!is_truthy(&json!(null)));
        assert!(!is_truthy(&json!(0)));
        assert!(!is_truthy(&json!(false)));
        assert!(is_truthy(&json!("x")));
        assert!(is_truthy(&json!([])));
        assert!(is_truthy(&json!({"name": "a"})));
    }
}

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The four-tier skill-attribution compliance grade and the layered-provenance
//! rule. Ported verbatim from the TypeScript reference.

use serde::{Deserialize, Serialize};

/// How completely a skill declares its attribution. String values match the
/// TypeScript port exactly (note the hyphen in `non-compliant`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComplianceLevel {
    /// Author + license + provenance + a populated upstream `sources[]` chain.
    #[serde(rename = "compliant_with_upstream_attribution")]
    CompliantWithUpstream,
    /// Author + license + provenance, but no declared upstream chain.
    #[serde(rename = "compliant")]
    Compliant,
    /// Some attribution present (author or license), but incomplete.
    #[serde(rename = "partial")]
    Partial,
    /// No author and no license.
    #[serde(rename = "non-compliant")]
    NonCompliant,
}

/// The booleans that drive the grade. `has_source` encodes the layered rule:
/// provenance counts as established by EITHER a scalar `source` / `homepage` /
/// `repository` URL OR a populated `sources[]` chain backed by a freeform
/// `attribution` block.
#[derive(Clone, Copy, Debug, Default)]
pub struct ComplianceInputs {
    pub has_author: bool,
    pub has_license: bool,
    pub has_source: bool,
    pub has_chain: bool,
}

impl ComplianceInputs {
    /// Resolve the four-tier grade. Mirrors the nested ternary in the TS port.
    pub fn grade(&self) -> ComplianceLevel {
        if self.has_author && self.has_license && self.has_source && self.has_chain {
            ComplianceLevel::CompliantWithUpstream
        } else if self.has_author && self.has_license && self.has_source {
            ComplianceLevel::Compliant
        } else if self.has_author || self.has_license {
            ComplianceLevel::Partial
        } else {
            ComplianceLevel::NonCompliant
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(a: bool, l: bool, s: bool, c: bool) -> ComplianceInputs {
        ComplianceInputs {
            has_author: a,
            has_license: l,
            has_source: s,
            has_chain: c,
        }
    }

    #[test]
    fn full_provenance_is_compliant_with_upstream() {
        assert_eq!(
            inputs(true, true, true, true).grade(),
            ComplianceLevel::CompliantWithUpstream
        );
    }

    #[test]
    fn no_chain_is_compliant() {
        assert_eq!(
            inputs(true, true, true, false).grade(),
            ComplianceLevel::Compliant
        );
    }

    #[test]
    fn author_only_is_partial() {
        assert_eq!(
            inputs(true, false, false, false).grade(),
            ComplianceLevel::Partial
        );
        assert_eq!(
            inputs(false, true, false, false).grade(),
            ComplianceLevel::Partial
        );
    }

    #[test]
    fn nothing_is_non_compliant() {
        assert_eq!(
            inputs(false, false, true, true).grade(),
            ComplianceLevel::NonCompliant
        );
    }

    #[test]
    fn serializes_with_hyphen() {
        assert_eq!(
            serde_json::to_value(ComplianceLevel::NonCompliant).unwrap(),
            serde_json::json!("non-compliant")
        );
        assert_eq!(
            serde_json::to_value(ComplianceLevel::CompliantWithUpstream).unwrap(),
            serde_json::json!("compliant_with_upstream_attribution")
        );
    }
}

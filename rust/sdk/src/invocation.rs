// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The invocation context handed to every interceptor handler, plus the
//! injectable [`Clock`] used for deterministic timestamps in audit records.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::Phase;

/// The context passed to an interceptor handler for a single invocation.
#[derive(Clone, Debug)]
pub struct Invocation {
    /// The lifecycle event, e.g. `"resources/read"`.
    pub event: String,
    /// The phase this invocation runs in.
    pub phase: Phase,
    /// The JSON payload (request params or response result). Validators MUST
    /// treat this as read-only.
    pub payload: Value,
    /// Per-invocation configuration.
    pub config: Map<String, Value>,
    /// Optional caller context (identity, trace, session).
    pub context: Option<InvocationContext>,
}

/// Optional context propagated alongside an invocation.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InvocationContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal: Option<Principal>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(rename = "spanId", skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// The identity of the caller making the intercepted request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Principal {
    #[serde(rename = "type")]
    pub principal_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claims: Option<Map<String, Value>>,
}

/// Supplies the `observedAt` timestamp for audit records. Injectable so tests
/// (and the demo) can produce deterministic output.
pub trait Clock: Send + Sync {
    /// Return the current time as an RFC 3339 / ISO 8601 UTC string.
    fn now_rfc3339(&self) -> String;
}

/// A [`Clock`] backed by the system wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_rfc3339(&self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        format_rfc3339_utc(now.as_secs())
    }
}

/// A [`Clock`] that always returns a fixed timestamp — useful for tests/demos.
#[derive(Clone, Debug)]
pub struct FixedClock(pub String);

impl Clock for FixedClock {
    fn now_rfc3339(&self) -> String {
        self.0.clone()
    }
}

/// Shared clock handle.
pub type SharedClock = Arc<dyn Clock>;

/// Format a UNIX timestamp (seconds) as an RFC 3339 UTC string
/// (`YYYY-MM-DDTHH:MM:SSZ`), with no external date dependency.
///
/// Uses Howard Hinnant's `civil_from_days` algorithm.
fn format_rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // days since 1970-01-01 -> civil date
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

#[cfg(test)]
mod tests {
    use super::format_rfc3339_utc;

    #[test]
    fn epoch_formats_correctly() {
        assert_eq!(format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn known_timestamp_formats_correctly() {
        // 2021-01-01T00:00:00Z = 1609459200
        assert_eq!(format_rfc3339_utc(1_609_459_200), "2021-01-01T00:00:00Z");
        // 2026-06-06T13:45:30Z = 1780753530
        assert_eq!(format_rfc3339_utc(1_780_753_530), "2026-06-06T13:45:30Z");
    }
}

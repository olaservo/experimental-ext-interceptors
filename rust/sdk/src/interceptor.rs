// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//! The [`Interceptor`] trait — the extension point implemented by validators and
//! mutators.

use async_trait::async_trait;

use crate::invocation::Invocation;
use crate::types::{InterceptorType, Metadata};

/// A boxed error returned by an interceptor handler. A returned `Err` (or a
/// timeout) is a *throw* in SEP-2624 terms: it aborts the chain unless the
/// interceptor declares `failOpen: true`.
pub type InterceptorError = Box<dyn std::error::Error + Send + Sync>;

/// A validation or mutation interceptor.
///
/// Implementors expose their [`Metadata`] and an async `invoke`. Validators MUST
/// treat [`Invocation::payload`] as read-only; mutators return the transformed
/// payload in their [`crate::types::MutationResult`].
#[async_trait]
pub trait Interceptor: Send + Sync {
    /// Static metadata describing this interceptor (name, hook, mode, …).
    fn metadata(&self) -> &Metadata;

    /// Run the interceptor for a single invocation.
    async fn invoke(
        &self,
        invocation: &Invocation,
    ) -> Result<crate::types::InvokeOutput, InterceptorError>;

    /// Whether this is a validation or mutation interceptor (derived from
    /// metadata).
    fn interceptor_type(&self) -> InterceptorType {
        self.metadata().interceptor_type
    }
}

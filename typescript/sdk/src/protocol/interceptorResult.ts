// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import { InterceptorPhaseSchema, ValidationSeveritySchema } from './enums.js';
import {
  ValidationMessageSchema,
  ValidationSuggestionSchema,
  type ValidationMessage,
} from './validation.js';

const baseFields = {
  /** Name of the interceptor that produced this result. */
  interceptor: z.string().optional(),
  phase: InterceptorPhaseSchema.optional(),
  durationMs: z.number().int().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
};

export const ValidationInterceptorResultSchema = z.object({
  type: z.literal('validation'),
  ...baseFields,
  valid: z.boolean(),
  severity: ValidationSeveritySchema.optional(),
  messages: z.array(ValidationMessageSchema).optional(),
  suggestions: z.array(ValidationSuggestionSchema).optional(),
});
export type ValidationInterceptorResult = z.infer<
  typeof ValidationInterceptorResultSchema
>;

export const MutationInterceptorResultSchema = z.object({
  type: z.literal('mutation'),
  ...baseFields,
  modified: z.boolean(),
  payload: z.unknown().optional(),
});
export type MutationInterceptorResult = z.infer<
  typeof MutationInterceptorResultSchema
>;

export const ObservabilityInterceptorResultSchema = z.object({
  type: z.literal('observability'),
  ...baseFields,
  observed: z.boolean(),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type ObservabilityInterceptorResult = z.infer<
  typeof ObservabilityInterceptorResultSchema
>;

/**
 * Polymorphic union over interceptor result types, discriminated by `type`.
 * Mirrors C# `InterceptorResult` with `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]`.
 */
export const InterceptorResultSchema = z.discriminatedUnion('type', [
  ValidationInterceptorResultSchema,
  MutationInterceptorResultSchema,
  ObservabilityInterceptorResultSchema,
]);
export type InterceptorResult = z.infer<typeof InterceptorResultSchema>;

// ---------------------------------------------------------------------------
// Convenience constructors. These mirror the C# static factory helpers.
// ---------------------------------------------------------------------------

export const ValidationResult = {
  success(): ValidationInterceptorResult {
    return { type: 'validation', valid: true };
  },
  failure(...messages: ValidationMessage[]): ValidationInterceptorResult {
    return {
      type: 'validation',
      valid: false,
      severity: 'error',
      messages: messages.length > 0 ? messages : undefined,
    };
  },
  error(message: string, path?: string): ValidationInterceptorResult {
    return ValidationResult.failure({ message, path, severity: 'error' });
  },
  warning(message: string, path?: string): ValidationInterceptorResult {
    return {
      type: 'validation',
      valid: true,
      severity: 'warn',
      messages: [{ message, path, severity: 'warn' }],
    };
  },
  info(message: string, path?: string): ValidationInterceptorResult {
    return {
      type: 'validation',
      valid: true,
      severity: 'info',
      messages: [{ message, path, severity: 'info' }],
    };
  },
};

export const MutationResult = {
  unchanged(payload: unknown): MutationInterceptorResult {
    return { type: 'mutation', modified: false, payload };
  },
  mutated(payload: unknown): MutationInterceptorResult {
    return { type: 'mutation', modified: true, payload };
  },
};

export const ObservabilityResult = {
  success(metrics?: Record<string, number>): ObservabilityInterceptorResult {
    return { type: 'observability', observed: true, metrics };
  },
  noop(): ObservabilityInterceptorResult {
    return { type: 'observability', observed: false };
  },
};


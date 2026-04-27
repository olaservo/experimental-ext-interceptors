// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import * as z from 'zod/v4';
import { ValidationSeveritySchema } from './enums.js';

export const ValidationMessageSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
  severity: ValidationSeveritySchema,
});
export type ValidationMessage = z.infer<typeof ValidationMessageSchema>;

export const ValidationSuggestionSchema = z.object({
  path: z.string(),
  value: z.unknown().optional(),
});
export type ValidationSuggestion = z.infer<typeof ValidationSuggestionSchema>;

export const ChainValidationSummarySchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  infos: z.number().int().nonnegative(),
});
export type ChainValidationSummary = z.infer<typeof ChainValidationSummarySchema>;

export const ChainAbortInfoSchema = z.object({
  interceptor: z.string(),
  reason: z.string(),
  type: z.string(),
});
export type ChainAbortInfo = z.infer<typeof ChainAbortInfoSchema>;

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

import {
  defineInterceptor,
  InterceptorEvents,
  type McpInterceptor,
  type ValidationMessage,
} from '@ext-modelcontextprotocol/interceptors';
import { load as parseYaml } from 'js-yaml';

/**
 * Recognise SEP-2640 skill resources by URI prefix. The SEP defines `skill://`
 * as the canonical scheme; servers MAY also use a native scheme like
 * `github://owner/repo/skills/<name>/SKILL.md` when each entry is listed in
 * `skill://index.json`. We accept both shapes for the demo and only validate
 * the SKILL.md file itself (other files in the skill directory are passed
 * through untouched).
 */
function isSkillManifest(uri: string): boolean {
  if (uri.startsWith('skill://') && uri.endsWith('/SKILL.md')) return true;
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(uri) && uri.endsWith('/SKILL.md')) {
    return true;
  }
  return false;
}

/** Final segment before `/SKILL.md` is the skill name per SEP-2640. */
function skillNameFromUri(uri: string): string | undefined {
  const m = uri.match(/\/([^/]+)\/SKILL\.md$/);
  return m?.[1];
}

interface Frontmatter {
  name?: string;
  description?: string;
  author?: string | { name?: string; email?: string; url?: string };
  license?: string;
  source?: string;
  homepage?: string;
  repository?: string;
  citations?: unknown;
  references?: unknown;
  version?: string;
  [k: string]: unknown;
}

/**
 * Extract YAML frontmatter from a SKILL.md body. Returns undefined if the
 * document doesn't start with a `---` fence.
 */
function parseFrontmatter(text: string): Frontmatter | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const block = text.slice(3, end).trim();
  try {
    const parsed = parseYaml(block);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Frontmatter;
    }
  } catch {
    // Malformed YAML — caller will surface as an error message.
  }
  return undefined;
}

interface AuditTuple {
  skill: { uri: string; name?: string };
  attribution: {
    author?: string | { name?: string; email?: string; url?: string };
    license?: string;
    source?: string;
    citations?: unknown;
    version?: string;
  };
  requester?: {
    type?: string;
    id?: string;
    claims?: Record<string, unknown>;
  };
  traceId?: string;
  observedAt: string;
  complianceLevel: 'compliant' | 'partial' | 'non-compliant';
}

/**
 * Validation interceptor on `resources/read` (response phase) that checks
 * SKILL.md frontmatter for attribution fields and records a per-read audit
 * tuple combining the skill identity and the requester (`context.principal`).
 *
 * Severity policy (deliberately non-blocking):
 * - Missing `author` or `license`     → `warn`
 * - Missing `source` / `citations` /
 *   `version`                          → `info`
 * - Body has no YAML frontmatter at all → `error` (this is a SEP-2640
 *   conformance failure, not just an attribution gap)
 *
 * `error` severity blocks per SEP-2624 chain semantics; everything else lets
 * the read complete. Hosts that prefer hard enforcement can configure their
 * gateway to treat `warn` as blocking too.
 */
export const skillAttributionValidator: McpInterceptor = defineInterceptor({
  name: 'skill-attribution-validator',
  description:
    'Validates SEP-2640 skill manifests carry attribution (author, license, source) and records a (skill, author, requester, ts) audit tuple.',
  events: [InterceptorEvents.ResourcesRead],
  type: 'validation',
  phase: 'response',
  invoke: ({ payload, context }) => {
    const messages: ValidationMessage[] = [];

    // Pull the URI out of the read response. The SDK serialises the response
    // payload directly, so this is whatever shape the backend returned. For a
    // SEP-conformant `resources/read` result the relevant fields are
    // `contents[].uri` and `contents[].text`.
    const result = (payload ?? {}) as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>;
    };
    const first = Array.isArray(result.contents) ? result.contents[0] : undefined;
    const uri = first?.uri;
    if (!uri || !isSkillManifest(uri)) {
      // Not a skill manifest — pass through silently. We only opine on
      // SKILL.md reads.
      return { type: 'validation', valid: true };
    }

    const observedAt = new Date().toISOString();
    const skillName = skillNameFromUri(uri);
    let attribution: AuditTuple['attribution'] = {};
    let complianceLevel: AuditTuple['complianceLevel'] = 'non-compliant';

    const text = first?.text;
    if (typeof text !== 'string') {
      messages.push({
        path: '$.contents[0].text',
        message: 'SKILL.md resource has no text content to inspect.',
        severity: 'error',
      });
    } else {
      const fm = parseFrontmatter(text);
      if (!fm) {
        messages.push({
          path: '$.contents[0].text',
          message:
            'SKILL.md does not begin with valid YAML frontmatter (per SEP-2640 / Agent Skills spec).',
          severity: 'error',
        });
      } else {
        attribution = {
          author: fm.author,
          license: fm.license,
          source: fm.source ?? fm.homepage ?? fm.repository,
          citations: fm.citations ?? fm.references,
          version: fm.version,
        };

        if (!fm.author) {
          messages.push({
            path: '$.frontmatter.author',
            message:
              'Skill is missing `author` — attribution credit cannot be assigned.',
            severity: 'warn',
          });
        }
        if (!fm.license) {
          messages.push({
            path: '$.frontmatter.license',
            message:
              'Skill is missing `license` — reuse and redistribution rights are unclear.',
            severity: 'warn',
          });
        }
        if (!attribution.source) {
          messages.push({
            path: '$.frontmatter.source',
            message:
              'Skill is missing `source` / `homepage` / `repository` — provenance is unverifiable.',
            severity: 'info',
          });
        }
        if (!attribution.citations) {
          messages.push({
            path: '$.frontmatter.citations',
            message:
              'Skill declares no `citations` / `references` — outside material is unattributed.',
            severity: 'info',
          });
        }
        if (!fm.version) {
          messages.push({
            path: '$.frontmatter.version',
            message:
              'Skill is missing `version` — reproducibility is harder.',
            severity: 'info',
          });
        }

        const hasAuthor = !!fm.author;
        const hasLicense = !!fm.license;
        if (hasAuthor && hasLicense) {
          complianceLevel = attribution.source ? 'compliant' : 'partial';
        } else if (hasAuthor || hasLicense) {
          complianceLevel = 'partial';
        }
      }
    }

    const tuple: AuditTuple = {
      skill: { uri, name: skillName },
      attribution,
      requester: context?.principal,
      traceId: context?.traceId,
      observedAt,
      complianceLevel,
    };

    // Record-keeping: the per-read tuple lands on stderr as a one-line JSON
    // event, ready to be tailed into a real ledger by an external collector.
    // This is the seam the future "compensation" / "marketplace feedback"
    // layers would consume.
    process.stderr.write(`[skill-attribution] ${JSON.stringify(tuple)}\n`);

    const hasError = messages.some((m) => m.severity === 'error');
    return {
      type: 'validation',
      valid: !hasError,
      severity: hasError
        ? 'error'
        : messages.some((m) => m.severity === 'warn')
          ? 'warn'
          : messages.length > 0
            ? 'info'
            : undefined,
      messages: messages.length > 0 ? messages : undefined,
      info: tuple as unknown as Record<string, unknown>,
    };
  },
});

// Copyright 2025 The MCP Interceptors Authors. All rights reserved.
// Use of this source code is governed by an Apache-2.0
// license that can be found in the LICENSE file.

//
// Ported from the fork's `samples/skill-attribution-gateway` onto Bob's PR #13
// SDK API. The attribution / compliance-grading / audit-tuple logic is preserved
// verbatim; only the SDK wiring changed:
//   - `defineInterceptor({…, invoke})`  → `RegisteredInterceptor` object form
//   - `InterceptorEvents`               → `InterceptionEvents`
//   - `invoke({payload, context})`      → `handler(params)` reading params.*
//   - result builders                   → `validationSuccess(phase)` / inline result
//
import {
  InterceptionEvents,
  validationSuccess,
  type RegisteredInterceptor,
  type ValidationMessage,
  type ValidationSeverity,
} from '../../../dist/index.js';
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
  skill_author?: string | { name?: string; email?: string; url?: string };
  license?: string;
  source?: string;
  homepage?: string;
  repository?: string;
  citations?: unknown;
  references?: unknown;
  version?: string;
  derived_from?: unknown;
  sources?: unknown;
  attribution?: unknown;
  depends_on?: unknown;
  own_contributions?: unknown;
  metadata?: Record<string, unknown>;
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

/**
 * Per the Agent Skills spec, only `name`, `description`, `license`,
 * `compatibility`, `metadata`, and `allowed-tools` are recognised at the top
 * of the frontmatter; everything else lives under `metadata`. Resolve custom
 * fields by checking `metadata` first and falling back to the top level for
 * legacy SKILL.md files that haven't migrated.
 */
function metadataField<T = unknown>(fm: Frontmatter, key: string): T | undefined {
  const md = fm.metadata;
  if (md && typeof md === 'object' && !Array.isArray(md) && md[key] !== undefined) {
    return md[key] as T;
  }
  return fm[key] as T | undefined;
}

interface AuditTuple {
  skill: { uri: string; name?: string };
  attribution: {
    author?: string | { name?: string; email?: string; url?: string };
    license?: string;
    source?: string;
    citations?: unknown;
    version?: string;
    sources?: unknown;
    runtime_attribution?: string;
    depends_on?: unknown;
    own_contributions?: unknown;
  };
  requester?: {
    type?: string;
    id?: string;
    claims?: Record<string, unknown>;
  };
  traceId?: string;
  observedAt: string;
  complianceLevel:
    | 'compliant_with_upstream_attribution'
    | 'compliant'
    | 'partial'
    | 'non-compliant';
}

/**
 * Validation interceptor on `resources/read` (response phase) that checks
 * SKILL.md frontmatter for attribution fields and records a per-read audit
 * tuple combining the skill identity and the requester (`context.principal`).
 *
 * Field shape: the validator reads the layered-attribution shape
 * (`skill_author`, `sources[]`, `attribution`, `depends_on`,
 * `own_contributions`) and falls back to the older flat shape (`author`,
 * `derived_from[]`) so legacy SKILL.md files keep grading the same.
 *
 * Severity policy (deliberately non-blocking):
 * - Missing `skill_author`/`author` or `license` → `warn`
 * - Missing `source` / `citations` /
 *   `version` / `sources` (or legacy `derived_from`) → `info`
 * - Body has no YAML frontmatter at all → `error` (this is a SEP-2640
 *   conformance failure, not just an attribution gap)
 *
 * `error` severity blocks per SEP-2624 chain semantics; everything else lets
 * the read complete. Hosts that prefer hard enforcement can configure their
 * gateway to treat `warn` as blocking too.
 */
export const skillAttributionValidator: RegisteredInterceptor = {
  descriptor: {
    name: 'skill-attribution-validator',
    description:
      'Validates SEP-2640 skill manifests carry attribution (skill_author, license, source, sources[]) and records a (skill, author, requester, ts) audit tuple.',
    type: 'validation',
    hooks: [{ events: [InterceptionEvents.ResourcesRead], phase: 'response' }],
  },
  handler: (params) => {
    const { payload, phase, context } = params;
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
      return validationSuccess(phase);
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
        // Per the Agent Skills spec, custom fields live under `metadata`.
        // The lookup falls back to top-level so legacy SKILL.md files keep
        // grading the same; the message paths point at the spec-compliant
        // location regardless.
        const skillAuthor = metadataField<Frontmatter['skill_author']>(
          fm,
          'skill_author',
        );
        const legacyAuthor = metadataField<Frontmatter['author']>(fm, 'author');
        const author = skillAuthor ?? legacyAuthor;
        const sourcesField = metadataField(fm, 'sources');
        const derivedFromField = metadataField(fm, 'derived_from');
        const chain = Array.isArray(sourcesField)
          ? (sourcesField as unknown[])
          : Array.isArray(derivedFromField)
            ? (derivedFromField as unknown[])
            : undefined;
        const attributionField = metadataField(fm, 'attribution');
        const runtimeAttribution =
          typeof attributionField === 'string' ? attributionField : undefined;
        const dependsOnField = metadataField(fm, 'depends_on');
        const dependsOn = Array.isArray(dependsOnField)
          ? (dependsOnField as unknown[])
          : undefined;
        const ownContributionsField = metadataField(fm, 'own_contributions');
        const ownContributions = Array.isArray(ownContributionsField)
          ? (ownContributionsField as unknown[])
          : undefined;
        const sourceUrl =
          metadataField<string>(fm, 'source') ??
          metadataField<string>(fm, 'homepage') ??
          metadataField<string>(fm, 'repository');
        const citations =
          metadataField(fm, 'citations') ?? metadataField(fm, 'references');
        const version = metadataField<string>(fm, 'version');

        attribution = {
          author,
          license: fm.license,
          source: sourceUrl,
          citations,
          version,
          sources: chain,
          runtime_attribution: runtimeAttribution,
          depends_on: dependsOn,
          own_contributions: ownContributions,
        };

        const hasAuthor = !!author;
        const hasLicense = !!fm.license;
        const hasChain = !!chain && chain.length > 0;
        // Provenance counts as established by EITHER a scalar `source` /
        // `homepage` / `repository` URL OR the layered-attribution shape: a
        // populated `sources[]` chain backed by a freeform `attribution` block.
        const hasSource =
          !!attribution.source || (hasChain && !!runtimeAttribution);

        if (!author) {
          messages.push({
            path: '$.frontmatter.metadata.skill_author',
            message:
              'Skill is missing `skill_author` (or legacy `author`) — attribution credit cannot be assigned.',
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
        if (!hasSource) {
          messages.push({
            path: '$.frontmatter.metadata.source',
            message:
              'Skill declares no provenance — needs a `source` / `homepage` / `repository` URL or a `sources[]` chain plus an `attribution` block.',
            severity: 'info',
          });
        }
        if (!attribution.citations) {
          messages.push({
            path: '$.frontmatter.metadata.citations',
            message:
              'Skill declares no `citations` / `references` — outside material is unattributed.',
            severity: 'info',
          });
        }
        if (!version) {
          messages.push({
            path: '$.frontmatter.metadata.version',
            message: 'Skill is missing `version` — reproducibility is harder.',
            severity: 'info',
          });
        }
        if (!hasChain) {
          messages.push({
            path: '$.frontmatter.metadata.sources',
            message:
              'Skill declares no `sources` (or legacy `derived_from`) — upstream chain undeclared.',
            severity: 'info',
          });
        }

        complianceLevel =
          hasAuthor && hasLicense && hasSource && hasChain
            ? 'compliant_with_upstream_attribution'
            : hasAuthor && hasLicense && hasSource
              ? 'compliant'
              : hasAuthor || hasLicense
                ? 'partial'
                : 'non-compliant';
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
    const severity: ValidationSeverity | undefined = hasError
      ? 'error'
      : messages.some((m) => m.severity === 'warn')
        ? 'warn'
        : messages.length > 0
          ? 'info'
          : undefined;
    return {
      type: 'validation',
      phase,
      valid: !hasError,
      severity,
      messages: messages.length > 0 ? messages : undefined,
      info: tuple as unknown as Record<string, unknown>,
    };
  },
};

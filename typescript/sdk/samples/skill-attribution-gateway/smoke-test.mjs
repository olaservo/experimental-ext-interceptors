// Smoke test over Streamable HTTP. Assumes the sample is already listening:
//   node dist/index.js &
//   node smoke-test.mjs                          # default http://localhost:39818/mcp
//   node smoke-test.mjs http://host:port/path    # custom URL
//
// For each of three skill fixtures (clean, missing-license,
// missing-author+license) we:
//   - call executeRemoteChain with a synthetic `resources/read` response
//     payload, verify status / messages / info
//   - wrap a tiny in-memory backend that serves the same fixtures via
//     `resources/read` and exercise InterceptingClient with a principal,
//     verify the audit tuple captures the requester
//
// Exits 0 on success.

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  executeRemoteChain,
  InterceptingClient,
  listInterceptors,
} from '@ext-modelcontextprotocol/interceptors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILLS = {
  clean: {
    uri: 'skill://acme/billing/refunds/SKILL.md',
    text: `---
name: refunds
description: Process customer refund requests
author: Jane Doe
license: Apache-2.0
source: https://example.com/skills/refunds
version: 1.2.0
citations:
  - https://example.com/refund-policy
---

# Refunds skill

Body content here.
`,
  },
  missingLicense: {
    uri: 'skill://teams/devops/incident-triage/SKILL.md',
    text: `---
name: incident-triage
description: Diagnose production incidents
author: Jane DevOps
version: 0.3.1
---

Steps...
`,
  },
  missingAuthorAndLicense: {
    uri: 'skill://random/SKILL.md',
    text: `---
name: random
description: A skill someone wrote
---

Body.
`,
  },
  // Layered TTRPG fixtures — mirror the real SKILL.md frontmatter shipped in
  // bellagio/agent-skills-ttrpg-demo/mcp/fallout-helper/skills/fallout-ttrpg/.
  // Each one exercises a different complianceLevel for the demo scroll. These
  // fixtures use the spec-compliant shape (custom fields nested under
  // `metadata` per the Agent Skills spec); the gateway also accepts the
  // legacy top-level shape, exercised by the `clean` / `missingLicense` /
  // `missingAuthorAndLicense` fixtures above.
  falloutRpg: {
    uri: 'skill://olaservo/fallout-helper/fallout-rpg/SKILL.md',
    text: `---
name: fallout-rpg
description: Run, GM, or adjudicate Fallout - The Roleplaying Game (Modiphius 2d20 system, Bethesda's Fallout IP).
license: See LICENSE.txt
metadata:
  version: 0.1.0
  skill_author: olaservo
  source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg
  sources:
    - title: 2d20 System Reference Document
      publisher: Modiphius Entertainment
      url: https://www.drivethrurpg.com/en/product/403658/2d20-system-reference-document
      rights_basis: license_grant
      covers: 2d20 mechanics - resolution loop, skill tests, AP economy, complications, Combat Dice
    - title: "Fallout: The Roleplaying Game - Quickstart Guide"
      publisher: Modiphius Entertainment
      ip_holder: Bethesda Softworks
      url: https://modiphius.us/collections/fallout-the-roleplaying-game/products/fallout-the-roleplaying-game-quickstart-guide-pdf-free
      rights_basis: fair_use_claim
      covers: Fallout-specific overlays - S.P.E.C.I.A.L., hit-location chart, sample pregens, Pip-Boy UI theming
    - title: "Fallout: The Roleplaying Game - Core Rulebook"
      publisher: Modiphius Entertainment
      ip_holder: Bethesda Softworks
      rights_basis: fair_use_claim
      covers: combat chapter detail, full character creation, perks and gear
  attribution: |
    Unofficial fan project. Mechanics adapted from the 2d20 System Reference
    Document by Modiphius Entertainment. Fallout-specific elements summarized
    from Fallout: The Roleplaying Game by Modiphius Entertainment under license
    from Bethesda Softworks.
---

Body.
`,
  },
  falloutMachineFrequency: {
    uri: 'skill://olaservo/fallout-helper/fallout-machine-frequency/SKILL.md',
    text: `---
name: fallout-machine-frequency
description: Run or GM "Machine Frequency", a three-act Fallout - The Roleplaying Game adventure module.
license: CC-BY-NC-SA-4.0
metadata:
  version: 0.2.0
  skill_author:
    name: Ola Hungerford
    url: https://github.com/olaservo
  source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-machine-frequency
  depends_on:
    - fallout-rpg
  sources:
    - title: fallout-rpg (sibling skill)
      publisher: Ola Hungerford
      url: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg
      relationship: system_encoding
      rights_basis: license_grant
      license: CC-BY-4.0
      covers: 2d20 mechanics referenced in stat blocks, skill tests, and combat encounters
    - title: "Fallout: The Roleplaying Game - Adventure Module Chapter Three: Machine Frequency"
      publisher: Modiphius Entertainment
      ip_holder: Bethesda Softworks
      year: 2022
      relationship: adventure_reading_aid
      rights_basis: fair_use_reading_aid
      covers: adventure structure, location summaries, NPC roles, plot beats, GM gotchas
  attribution: |
    Structural encoding of the Machine Frequency adventure for Fallout: The
    Roleplaying Game (Modiphius Entertainment), used as a reading aid for GMs
    who own the published module.
---

Body.
`,
  },
  falloutCharacterSheets: {
    uri: 'skill://olaservo/fallout-helper/fallout-character-sheets/SKILL.md',
    text: `---
name: fallout-character-sheets
description: Pre-generated player characters for Fallout - The Roleplaying Game (Modiphius 2d20).
license: CC-BY-4.0
metadata:
  version: 1.0.0
  skill_author:
    name: Ola Hungerford
    url: https://github.com/olaservo
  source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-character-sheets
  depends_on:
    - fallout-rpg
  sources:
    - title: fallout-rpg (sibling skill)
      publisher: Ola Hungerford
      url: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg
      relationship: system_encoding
      rights_basis: license_grant
      license: CC-BY-4.0
      covers: 2d20 mechanics (S.P.E.C.I.A.L., skills, perks, AP, Luck, combat resolution)
    - title: "Fallout: The Roleplaying Game (Core Rulebook)"
      publisher: Modiphius Entertainment
      ip_holder: Bethesda Softworks
      year: 2021
      url: https://www.modiphius.net/products/fallout-the-roleplaying-game
      relationship: trademark_setting_vocabulary
      rights_basis: fair_use_claim
      covers: Fallout-universe origins and trademark terms used in pregen backgrounds
  own_contributions:
    - Six original pre-generated player characters with full sheets, biographies, and inventories
    - Picker logic for matching players to characters by play style
    - Composition guidance for pairing the party with the fallout-machine-frequency adventure
  attribution: |
    Six pre-generated player characters by Ola Hungerford, licensed CC-BY-4.0.
    Built on the fallout-rpg sibling skill for 2d20 system mechanics. Uses
    Fallout-universe setting vocabulary under fair use claim.
---

Body.
`,
  },
  falloutUncreditedEncounters: {
    uri: 'skill://olaservo/fallout-helper/fallout-uncredited-encounters/SKILL.md',
    text: `---
name: fallout-uncredited-encounters
description: A table of random wasteland encounters for Fallout 2d20.
---

Body.
`,
  },
};

function readResultFor(skillKey) {
  const f = SKILLS[skillKey];
  return {
    contents: [
      {
        uri: f.uri,
        mimeType: 'text/markdown',
        text: f.text,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Connect a Client to the running HTTP gateway.
// ---------------------------------------------------------------------------

const url = new URL(process.argv[2] ?? 'http://localhost:39818/mcp');
const transport = new StreamableHTTPClientTransport(url);
const client = new Client(
  { name: 'attribution-smoke', version: '0.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

const list = await listInterceptors(client);
assert.equal(list.interceptors.length, 1, 'expected 1 interceptor');
assert.equal(list.interceptors[0].name, 'skill-attribution-validator');
console.log('listInterceptors: %s', list.interceptors[0].name);

// ---------------------------------------------------------------------------
// 2. executeRemoteChain on each fixture.
// ---------------------------------------------------------------------------

async function chainFor(skillKey, principal) {
  return executeRemoteChain([client], {
    event: 'resources/read',
    phase: 'response',
    payload: readResultFor(skillKey),
    context: principal
      ? { principal, traceId: `trace-${skillKey}` }
      : undefined,
  });
}

// Clean skill → success, no validation messages, compliant.
const clean = await chainFor('clean', { type: 'user', id: 'alice@example.com' });
console.log('clean:', clean.status, clean.validationSummary);
assert.equal(clean.status, 'success');
assert.equal(clean.validationSummary?.errors, 0);
assert.equal(clean.validationSummary?.warnings, 0);
const cleanResult = clean.results[0];
assert.equal(cleanResult.type, 'validation');
assert.equal(cleanResult.valid, true);
assert.equal(cleanResult.info.complianceLevel, 'compliant');
assert.equal(cleanResult.info.skill.name, 'refunds');
assert.equal(cleanResult.info.attribution.author, 'Jane Doe');
assert.equal(cleanResult.info.attribution.license, 'Apache-2.0');
assert.equal(cleanResult.info.requester.id, 'alice@example.com');

// Missing license → success (warn doesn't block), one warning, partial.
const noLicense = await chainFor('missingLicense', {
  type: 'service',
  id: 'monitoring-bot',
});
console.log('missingLicense:', noLicense.status, noLicense.validationSummary);
assert.equal(noLicense.status, 'success');
assert.equal(noLicense.validationSummary?.warnings, 1);
const noLicResult = noLicense.results[0];
assert.equal(noLicResult.info.complianceLevel, 'partial');
assert.equal(noLicResult.info.attribution.author, 'Jane DevOps');
assert.equal(noLicResult.info.attribution.license, undefined);
assert.equal(noLicResult.info.requester.type, 'service');
assert.ok(
  noLicResult.messages.some(
    (m) => m.path === '$.frontmatter.license' && m.severity === 'warn',
  ),
);

// Missing author AND license → success (still warns, doesn't block), 2 warns, non-compliant.
const noAuthor = await chainFor('missingAuthorAndLicense', {
  type: 'anonymous',
});
console.log('missingAuthorAndLicense:', noAuthor.status, noAuthor.validationSummary);
assert.equal(noAuthor.status, 'success');
assert.equal(noAuthor.validationSummary?.warnings, 2);
const noAuthorResult = noAuthor.results[0];
assert.equal(noAuthorResult.info.complianceLevel, 'non-compliant');
assert.equal(noAuthorResult.info.requester.type, 'anonymous');

// ---------------------------------------------------------------------------
// Layered TTRPG fixtures — demonstrate the four compliance levels in order.
// The visible argument: the same primitive that records compliance also
// records non-compliance, and discriminates between *kinds* of compliance
// (one-deep vs two-deep, encoded module vs original creative work).
// ---------------------------------------------------------------------------

// Fixture 1 — fallout-rpg: three-deep chain (2d20 SRD + Quickstart + Core).
const falloutRpg = await chainFor('falloutRpg', {
  type: 'user',
  id: 'gm@example.com',
});
console.log('falloutRpg:', falloutRpg.status, falloutRpg.validationSummary);
assert.equal(falloutRpg.status, 'success');
const falloutRpgResult = falloutRpg.results[0];
assert.equal(
  falloutRpgResult.info.complianceLevel,
  'compliant_with_upstream_attribution',
);
assert.equal(falloutRpgResult.info.attribution.sources.length, 3);
assert.equal(
  falloutRpgResult.info.attribution.sources[0].rights_basis,
  'license_grant',
);
assert.equal(
  falloutRpgResult.info.attribution.sources[1].rights_basis,
  'fair_use_claim',
);
// Runtime-surfacing attribution string is captured for hosts to render.
assert.ok(
  typeof falloutRpgResult.info.attribution.runtime_attribution === 'string' &&
    falloutRpgResult.info.attribution.runtime_attribution.includes(
      'Unofficial fan project',
    ),
);

// Fixture 2 — machine-frequency: two-deep chain (sibling system encoding +
// adventure reading aid).
const machineFreq = await chainFor('falloutMachineFrequency', {
  type: 'user',
  id: 'gm@example.com',
});
console.log(
  'falloutMachineFrequency:',
  machineFreq.status,
  machineFreq.validationSummary,
);
assert.equal(machineFreq.status, 'success');
const machineFreqResult = machineFreq.results[0];
assert.equal(
  machineFreqResult.info.complianceLevel,
  'compliant_with_upstream_attribution',
);
assert.equal(machineFreqResult.info.attribution.sources.length, 2);
assert.equal(
  machineFreqResult.info.attribution.sources[0].relationship,
  'system_encoding',
);
assert.equal(
  machineFreqResult.info.attribution.sources[1].relationship,
  'adventure_reading_aid',
);
assert.deepEqual(machineFreqResult.info.attribution.depends_on, [
  'fallout-rpg',
]);

// Fixture 3 — character-sheets: same chain depth as fixture 2, fundamentally
// different rights story (original PCs using a licensed substrate + setting
// trademark vocabulary).
const charSheets = await chainFor('falloutCharacterSheets', {
  type: 'user',
  id: 'gm@example.com',
});
console.log(
  'falloutCharacterSheets:',
  charSheets.status,
  charSheets.validationSummary,
);
assert.equal(charSheets.status, 'success');
const charSheetsResult = charSheets.results[0];
assert.equal(
  charSheetsResult.info.complianceLevel,
  'compliant_with_upstream_attribution',
);
assert.equal(charSheetsResult.info.attribution.sources.length, 2);
assert.equal(
  charSheetsResult.info.attribution.sources[0].relationship,
  'system_encoding',
);
assert.equal(
  charSheetsResult.info.attribution.sources[1].relationship,
  'trademark_setting_vocabulary',
);
assert.ok(
  Array.isArray(charSheetsResult.info.attribution.own_contributions) &&
    charSheetsResult.info.attribution.own_contributions.length === 3,
);

// Fixture 4 — uncredited-encounters: control case, non-compliant.
const uncredited = await chainFor('falloutUncreditedEncounters', {
  type: 'anonymous',
});
console.log(
  'falloutUncreditedEncounters:',
  uncredited.status,
  uncredited.validationSummary,
);
assert.equal(uncredited.status, 'success');
const uncreditedResult = uncredited.results[0];
assert.equal(uncreditedResult.info.complianceLevel, 'non-compliant');
assert.ok(
  uncreditedResult.messages.some(
    (m) =>
      m.path === '$.frontmatter.metadata.sources' && m.severity === 'info',
  ),
);

// Non-skill resource → pass-through (the validator only opines on SKILL.md).
const nonSkill = await executeRemoteChain([client], {
  event: 'resources/read',
  phase: 'response',
  payload: {
    contents: [{ uri: 'memory://config', mimeType: 'text/plain', text: 'hi' }],
  },
});
assert.equal(nonSkill.status, 'success');
assert.equal(nonSkill.validationSummary?.warnings, 0);
console.log('non-skill pass-through OK');

// ---------------------------------------------------------------------------
// 3. End-to-end via InterceptingClient against an in-memory backend.
// ---------------------------------------------------------------------------

const backendServer = new Server(
  { name: 'mock-skill-server', version: '0.0.0' },
  { capabilities: { resources: {} } },
);
backendServer.setRequestHandler(ReadResourceRequestSchema, (req) => {
  if (req.params.uri === SKILLS.clean.uri) return readResultFor('clean');
  if (req.params.uri === SKILLS.missingLicense.uri)
    return readResultFor('missingLicense');
  if (req.params.uri === SKILLS.missingAuthorAndLicense.uri)
    return readResultFor('missingAuthorAndLicense');
  return { contents: [] };
});
const [bsT, bcT] = InMemoryTransport.createLinkedPair();
const backendClient = new Client({ name: 'b-c', version: '0.0.0' }, { capabilities: {} });
await Promise.all([backendServer.connect(bsT), backendClient.connect(bcT)]);

const intercepting = new InterceptingClient(backendClient, {
  interceptorClient: client,
  events: ['resources/read'],
  defaultContext: {
    principal: { type: 'user', id: 'wrapped-alice@example.com' },
    traceId: 'trace-wrapped',
  },
});

const ok = await intercepting.readResource({ uri: SKILLS.clean.uri });
assert.equal(ok.contents[0].uri, SKILLS.clean.uri);
console.log('InterceptingClient.readResource passed through clean skill');

const partial = await intercepting.readResource({
  uri: SKILLS.missingLicense.uri,
});
assert.equal(partial.contents[0].uri, SKILLS.missingLicense.uri);
console.log('InterceptingClient.readResource passed through partial skill (warn)');

await backendClient.close();
await backendServer.close();
await client.close();
console.log('skill-attribution smoke-test OK');
process.exit(0);

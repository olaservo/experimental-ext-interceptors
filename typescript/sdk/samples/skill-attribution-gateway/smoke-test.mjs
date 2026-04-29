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
  // Each one exercises a different complianceLevel for the demo scroll.
  falloutRpg: {
    uri: 'skill://olaservo/fallout-helper/fallout-rpg/SKILL.md',
    text: `---
name: fallout-rpg
description: Run, GM, or adjudicate Fallout - The Roleplaying Game (Modiphius 2d20 system).
version: 1.0.0
author:
  name: Ola Hungerford
license: CC-BY-4.0
source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg
derived_from:
  - title: "Fallout: The Roleplaying Game (Core Rulebook)"
    publisher: Modiphius Entertainment
    year: 2021
    relationship: system
    license: proprietary
    rights_basis: fair_use_reading_aid
    url: https://www.modiphius.net/products/fallout-the-roleplaying-game
---

Body.
`,
  },
  falloutMachineFrequency: {
    uri: 'skill://olaservo/fallout-helper/fallout-machine-frequency/SKILL.md',
    text: `---
name: fallout-machine-frequency
description: Run or GM "Machine Frequency", a three-act Fallout - The Roleplaying Game adventure module.
version: 0.2.0
author:
  name: Ola Hungerford
license: CC-BY-NC-SA-4.0
source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-machine-frequency
derived_from:
  - title: "Fallout: The Roleplaying Game (Core Rulebook)"
    publisher: Modiphius Entertainment
    year: 2021
    relationship: system
    license: proprietary
    rights_basis: fair_use_reading_aid
    url: https://www.modiphius.net/products/fallout-the-roleplaying-game
  - title: "Fallout: The Roleplaying Game — Adventure Module Chapter Three: Machine Frequency"
    publisher: Modiphius Entertainment
    year: 2022
    relationship: adventure
    license: proprietary
    rights_basis: fair_use_reading_aid
---

Body.
`,
  },
  falloutCharacterSheets: {
    uri: 'skill://olaservo/fallout-helper/fallout-character-sheets/SKILL.md',
    text: `---
name: fallout-character-sheets
description: Pre-generated player characters for Fallout - The Roleplaying Game (Modiphius 2d20).
version: 1.0.0
author:
  name: Ola Hungerford
license: CC-BY-4.0
source: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-character-sheets
derived_from:
  - title: "Fallout: The Roleplaying Game (Core Rulebook)"
    publisher: Modiphius Entertainment
    year: 2021
    relationship: system
    license: proprietary
    rights_basis: fair_use_reading_aid
    url: https://www.modiphius.net/products/fallout-the-roleplaying-game
  - title: "fallout-rpg"
    publisher: Ola Hungerford
    year: 2026
    relationship: system_encoding
    license: CC-BY-4.0
    url: https://github.com/olaservo/agent-skills-ttrpg-demo/tree/main/mcp/fallout-helper/skills/fallout-ttrpg/fallout-rpg
own_contributions:
  - Six original pre-generated player characters with full sheets, biographies, and inventories
  - Picker logic for matching players to characters by play style
  - Composition guidance for pairing the party with the fallout-machine-frequency adventure
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

// Fixture 1 — fallout-rpg: one-deep chain (Modiphius system).
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
assert.equal(falloutRpgResult.info.attribution.derived_from.length, 1);
assert.equal(
  falloutRpgResult.info.attribution.derived_from[0].relationship,
  'system',
);

// Fixture 2 — machine-frequency: two-deep chain (system + adventure module).
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
assert.equal(machineFreqResult.info.attribution.derived_from.length, 2);
assert.equal(
  machineFreqResult.info.attribution.derived_from[1].relationship,
  'adventure',
);

// Fixture 3 — character-sheets: same chain depth as fixture 2, fundamentally
// different rights story (original PCs encoding the licensed system).
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
assert.equal(charSheetsResult.info.attribution.derived_from.length, 2);
assert.equal(
  charSheetsResult.info.attribution.derived_from[1].relationship,
  'system_encoding',
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
      m.path === '$.frontmatter.derived_from' && m.severity === 'info',
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

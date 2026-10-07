// Upload the packages, give each committee member a party on their own
// participant, and deploy the stock GovernanceRules contract (2-of-3) for the
// decentralized issuer through DecMan's multi-party /contracts workflow.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { nodes, dm } from './peers.mjs';
import { participants, api, localToken } from './ledger-users.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { members: [] };

// 1. Packages on every participant. The kit and setup DARs carry the Registry
// and token-standard packages they were built against.
const dars = [
  'daml/dars/governance-core-v1-0.1.0.dar',
  'daml/intentta-redemption/.daml/dist/intentta-redemption-v1-0.1.0.dar',
  'daml/intentta-issuer-setup/.daml/dist/intentta-issuer-setup-v1-0.1.0.dar',
];
for (const p of participants) {
  for (const dar of dars) {
    const res = await fetch(p.json + '/v2/packages', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${localToken('participant_admin')}` },
      body: readFileSync(dar),
    });
    if (!res.ok) throw new Error(`${p.name} upload ${dar}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  console.log(`${p.name}: packages uploaded`);
}

// 2. The issuer party and one member party per participant.
const issuer = (await dm(nodes[0], 'GET', '/decentralized-parties')).parties[0];
state.issuer = issuer.party_id;
const grant = (p, party) => api(p, 'POST', '/v2/users/ledger-api-user/rights', {
  userId: 'ledger-api-user', identityProviderId: '',
  rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }],
});
for (const [i, p] of participants.slice(0, 3).entries()) {
  const r = await api(p, 'POST', '/v2/parties', { partyIdHint: `member${i + 1}`, identityProviderId: '' });
  const member = r.partyDetails.party;
  state.members.push(member);
  await grant(p, member);
  await grant(p, state.issuer);
  await dm(nodes[i], 'PUT', '/party-config', {
    dec_party_id: state.issuer, member_party_id: member, user_id: 'ledger-api-user',
    keycloak_url: '', keycloak_realm: '', keycloak_client_id: '',
    packages: {
      governance_action: '#governance-action-v1',
      governance_core: '#governance-core-v1',
      utility_registry: '#utility-registry-app-v0',
    },
  });
  console.log(`${p.name}: ${member.split('::')[0]} allocated and configured on decman${i + 1}`);
}

// 3. GovernanceRules, signed by the decentralized party's owners.
await dm(nodes[0], 'POST', '/contracts', {
  decentralized_party_id: state.issuer,
  participant_ids: issuer.participants.map((x) => x.participant_uid),
  participant_parties: state.members,
  operator_party: state.members[0],
  contracts: [{
    id: 'governance-rules', name: 'GovernanceRules',
    package_id: '#governance-core-v1', module_name: 'Governance.Rules', entity_name: 'GovernanceRules',
    fields: [
      { type: 'decentralized_party' },
      { type: 'party_set', parties: state.members },
      { type: 'int64', value: 2 },
      { type: 'rel_time', microseconds: 1800000000 },
      { type: 'none' },
    ],
  }],
});
console.log('decman1 posted the GovernanceRules contract for signing');
for (const n of nodes.slice(1)) {
  let inv;
  for (let i = 0; i < 60 && !inv; i++) {
    inv = ((await dm(n, 'GET', '/invitations')).invitations || [])[0];
    if (!inv) await sleep(1000);
  }
  if (!inv) throw new Error(`no contracts invitation on decman${n.i}`);
  await dm(n, 'POST', '/invitations/accept', { id: inv.id });
  console.log(`decman${n.i} accepted ${inv.id}`);
}
for (let i = 0; i < 240; i++) {
  const s = await dm(nodes[0], 'GET', '/contracts/status');
  if (/completed/i.test(s.status || '')) { console.log('GovernanceRules deployed'); break; }
  if (/failed/i.test(s.status || '')) throw new Error(`contracts workflow failed: ${s.error}`);
  await sleep(1000);
}
const gov = await dm(nodes[0], 'GET', `/governance/state?party_id=${encodeURIComponent(state.issuer)}`);
console.log(JSON.stringify(gov).slice(0, 900));
state.governance = gov;
mkdirSync('.local/decman', { recursive: true });
writeFileSync('.local/decman/state.json', JSON.stringify(state, null, 2));

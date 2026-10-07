// Shared pieces for the DecMan run: one ledger client per participant, the
// DecMan REST calls for a custom governed action, and Registry choice contexts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Ledger, created, exercised } from '../../demo/lib/ledger.mjs';
import { T } from '../../demo/lib/kit.mjs';
import { nodes, dm } from './peers.mjs';
import { localToken } from './ledger-users.mjs';

export { nodes, dm, exercised };

const STATE = '.local/decman/state.json';
export const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
export const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

// Participants 1 to 3 belong to the committee members; 4 to the investors and
// the Registry-side parties.
const client = (port) => new Ledger({
  baseUrl: `http://localhost:${port}`,
  userId: 'ledger-api-user',
  token: () => localToken('ledger-api-user'),
});
export const P = { 1: client(5003), 2: client(5013), 3: client(5023), 4: client(5033) };

const REG = '#utility-registry-app-v0:Utility.Registry.App.V0';
const SETUP = '#intentta-issuer-setup-v1:IntentTA.IssuerSetup';
export const R = {
  ProviderService: `${REG}.Service.Provider:ProviderService`,
  RegistrarServiceRequest: `${REG}.Service.Registrar:RegistrarServiceRequest`,
  RegistrarService: `${REG}.Service.Registrar:RegistrarService`,
  Factory: `${REG}.Service.AllocationFactory:AllocationFactory`,
  MintOffer: `${REG}.Model.Mint:MintOffer`,
  InstrumentConfiguration: '#utility-registry-v0:Utility.Registry.V0.Configuration.Instrument:InstrumentConfiguration',
  TransferRule: '#utility-registry-v0:Utility.Registry.V0.Rule.Transfer:TransferRule',
  RequestRegistrarService: `${SETUP}:RequestRegistrarServiceAction`,
  LaunchFund: `${SETUP}:LaunchFundAction`,
  OfferShares: `${SETUP}:OfferSharesAction`,
  AcceptCash: `${SETUP}:AcceptCashAction`,
};

// The Registry's choice-context keys.
const KEY = 'utility.digitalasset.com/';
const cid = (value) => ({ tag: 'AV_ContractId', value });
const none = { tag: 'AV_List', value: [] };
export const issuerContext = (instrumentConfigurationCid) => ({
  context: { values: { [`${KEY}instrument-configuration`]: cid(instrumentConfigurationCid), [`${KEY}issuer-credentials`]: none } },
  meta: { values: {} },
});
export const transferContext = (token) => ({
  context: {
    values: {
      [`${KEY}instrument-configuration`]: cid(token.instrumentConfigurationCid),
      [`${KEY}transfer-rule`]: cid(token.transferRuleCid),
      [`${KEY}sender-credentials`]: none,
      [`${KEY}receiver-credentials`]: none,
      [`${KEY}issuer-credentials`]: none,
    },
  },
  meta: { values: {} },
});

// Disclosure records for contracts, read on the participant of a stakeholder.
export async function disclose(ledger, reader, contractIds) {
  const { disclosed, missing } = await ledger.disclosures(reader, contractIds);
  if (missing.length) throw new Error(`cannot disclose ${missing.join(', ')} as ${reader.split('::')[0]}`);
  return disclosed;
}

// The DecMan request body for a custom governed action (governance_type
// "core_domain"), where the proposal contract id identifies the action.
const request = (state, proposalCid) => ({
  party_id: state.issuer,
  rules_contract_id: state.rulesCid,
  // Required by the request schema but ignored for core_domain. DecMan v1.13
  // does not accept the `generic_vote` placeholder its guide shows, so a
  // no-op value is sent.
  action: { type: 'governance_set_threshold', new_threshold: 2 },
  governance_type: 'core_domain',
  proposal_cid: proposalCid,
});

// A member confirms on their own DecMan node.
export const confirmOn = (node, state, proposalCid) =>
  dm(node, 'POST', '/governance/confirm', request(state, proposalCid));

// The proposal as a DecMan node reports it, once `ready(action)` holds.
export async function pending(node, state, proposalCid, ready = () => true) {
  for (let i = 0; i < 60; i++) {
    const c = await dm(node, 'GET', `/governance/confirmations?party_id=${encodeURIComponent(state.issuer)}`);
    const action = (c.domain_actions || []).find((a) => a.proposal_cid === proposalCid);
    if (action && ready(action)) return action;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`proposal ${proposalCid.slice(0, 12)} not in the expected state on decman${node.i}`);
}

// A member executes on their own DecMan node, passing the contracts the
// governance party is not a stakeholder of.
export const executeOn = (node, state, action, disclosed = []) =>
  dm(node, 'POST', '/governance/execute', {
    ...request(state, action.proposal_cid),
    confirmation_cids: action.confirmations.map((x) => x.contract_id),
    disclosed_contracts: disclosed.map((d) => ({ contract_id: d.contractId, blob: d.createdEventBlob })),
  });

// Members 1 and 2 confirm on their nodes, member 3 executes on theirs.
export async function decide(state, proposalCid, { disclosed = [], label = '' } = {}) {
  const record = { label, proposalCid };
  record.confirmedOn = [];
  for (const node of nodes.slice(0, 2)) {
    await confirmOn(node, state, proposalCid);
    record.confirmedOn.push(`decman${node.i}`);
  }
  const action = await pending(nodes[2], state, proposalCid, (a) => a.can_execute);
  record.asSeenByDecman3 = {
    action_label: action.action_label,
    description: action.description,
    confirmations: action.confirmations.length,
    can_execute: action.can_execute,
  };
  record.executedOn = 'decman3';
  record.execute = await executeOn(nodes[2], state, action, disclosed);
  return record;
}

// --- Redemption steps on this network ----------------------------------------

export const currentPolicy = async (state) => (await P[1].query(state.issuer, T.Policy))[0];

// Member 1, on participant 1: propose approval of an investor's request.
export async function proposeApproval(state, intentCid, terms) {
  const [m1] = state.members;
  const treasury = (await P[1].query(state.issuer, T.Holding)).filter(
    (c) => c.payload.owner === state.issuer && c.payload.registrar === state.cash.registrar && c.payload.lock == null);
  const tx = await P[1].create(m1, T.ApproveAction, {
    governanceParty: state.issuer, proposer: m1, intentCid, terms,
    policyCid: (await currentPolicy(state)).contractId,
    cashFactoryCid: state.cash.allocationFactoryCid,
    cashHoldingCids: treasury.map((c) => c.contractId),
    allocateExtraArgs: transferContext(state.cash),
  });
  return { tx, proposalCid: created(tx, 'IntentTA.Redemption.Action:ApproveRedemptionAction')[0].contractId };
}

// What the committee's nodes need disclosed to execute an approval or a
// cleanup: the cash instrument's factory, configuration and transfer rule,
// read on the cash registrar's participant.
export const cashDisclosures = (state) =>
  disclose(P[4], state.cashAdmin, [state.cash.allocationFactoryCid, state.cash.instrumentConfigurationCid, state.cash.transferRuleCid]);

// The approval, once it has reached the investor's participant.
export async function findApproval(state, requestId) {
  for (let i = 0; i < 30; i++) {
    const a = (await P[4].query(state.investor, T.Approved)).find((c) => c.payload.terms.requestId === requestId);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`approval ${requestId} did not reach the investor's participant`);
}

// The network as the investor page and the kit helpers expect it: the same
// shape as the single-ledger bootstrap output, plus where each instrument's
// reference data is read.
export function writeNetFile(state, path = '.local/decman/net.json') {
  const key = (name) => `utility.digitalasset.com/${name}`;
  writeFileSync(path, JSON.stringify({
    issuer: state.issuer, members: state.members, rulesCid: state.rulesCid,
    investor: state.investor, investor2: state.investor2, outsider: state.outsider,
    operator: state.operator, cashAdmin: state.cashAdmin,
    share: { ...state.share, registryUrl: 'http://localhost:5003' },
    cash: { ...state.cash, registryUrl: 'http://localhost:5033' },
    contextKeys: {
      instrumentConfiguration: key('instrument-configuration'), issuerCredentials: key('issuer-credentials'),
      senderCredentials: key('sender-credentials'), receiverCredentials: key('receiver-credentials'),
      transferRule: key('transfer-rule'), appRewardConfiguration: key('app-reward-configuration'),
      featuredAppRight: key('featured-app-right'),
    },
  }, null, 2));
  return path;
}

export const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
export const short = (party) => party.split('::')[0];

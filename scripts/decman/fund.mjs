// Set up the fund on the DecMan network. The issuer is a decentralized party,
// so every step it takes is a governed action confirmed on two DecMan nodes
// and executed on the third.
//
//   node scripts/decman/fund.mjs
//
// Steps already recorded in .local/decman/state.json are skipped, so the
// script can be re-run after a failure.

import { created } from '../../demo/lib/ledger.mjs';
import { T } from '../../demo/lib/kit.mjs';
import { participants, api } from './ledger-users.mjs';
import { P, R, decide, disclose, issuerContext, loadState, saveState, exercised, iso, short } from './lib.mjs';

const state = loadState();
state.steps ||= {};
state.rulesCid ||= state.governance.state.contract_id;
const [m1] = state.members;
const p4 = participants[3];

// Poll until `read` returns something; transactions reach participants a
// moment apart.
async function eventually(read, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for the ledger');
}

async function step(name, fn) {
  if (state.steps[name]) return console.log(`= ${name} (done)`);
  console.log(`> ${name}`);
  state.steps[name] = (await fn()) || true;
  saveState(state);
}

// --- Parties on participant 4 ------------------------------------------------
await step('parties', async () => {
  for (const hint of ['registry-operator', 'cash-admin', 'investor', 'investor2', 'outsider']) {
    const party = (await api(p4, 'POST', '/v2/parties', { partyIdHint: hint, identityProviderId: '' })).partyDetails.party;
    await api(p4, 'POST', '/v2/users/ledger-api-user/rights', {
      userId: 'ledger-api-user', identityProviderId: '',
      rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }],
    });
    state[{ 'registry-operator': 'operator', 'cash-admin': 'cashAdmin' }[hint] || hint] = party;
  }
});
const { operator, cashAdmin, investor, investor2, issuer } = state;

// --- Registry: operator as provider, cash admin as registrar of TESTUSD -------
await step('registry', async () => {
  const service = await P[4].create(operator, R.ProviderService, { operator, provider: operator });
  const providerServiceCid = created(service, 'Utility.Registry.App.V0.Service.Provider:ProviderService')[0].contractId;
  const config = await P[4].exercise(operator, R.ProviderService, providerServiceCid,
    'ProviderService_CreateProviderConfiguration', { registrarRequirements: [], holderRequirements: [] });
  const providerConfigurationCid = exercised(config, 'ProviderService_CreateProviderConfiguration')[0].result.providerConfigurationCid;
  Object.assign(state, { providerServiceCid, providerConfigurationCid });
});

// The provider accepts a registrar's service request.
async function acceptRegistrar(registrar, reader, ledger) {
  let request;
  for (let i = 0; i < 30 && !request; i++) {
    request = (await P[4].query(operator, R.RegistrarServiceRequest)).find((c) => c.payload.registrar === registrar);
    if (!request) await new Promise((r) => setTimeout(r, 1000));
  }
  const tx = await P[4].exercise(operator, R.ProviderService, state.providerServiceCid,
    'ProviderService_AcceptRegistrarServiceRequest',
    { cid: request.contractId, payload: { providerConfigurationCid: state.providerConfigurationCid, credentialCids: [] } });
  const r = exercised(tx, 'ProviderService_AcceptRegistrarServiceRequest')[0].result;
  return { registrar, registrarServiceCid: r.registrarServiceCid, allocationFactoryCid: r.allocationFactoryCid, transferRuleCid: r.transferRuleCid, tx: tx.updateId };
}

await step('cash instrument', async () => {
  await P[4].create(cashAdmin, R.RegistrarServiceRequest,
    { operator, provider: operator, registrar: cashAdmin, createTransferRule: true, createAllocationFactory: true });
  const cash = await acceptRegistrar(cashAdmin);
  const tx = await P[4].exercise(cashAdmin, R.RegistrarService, cash.registrarServiceCid,
    'RegistrarService_CreateInstrumentConfiguration', {
      instrumentId: 'TESTUSD',
      additionalIdentifiers: [{ source: cashAdmin, id: 'TESTUSD', scheme: 'RegistrarInternalScheme' }],
      issuerRequirements: [], holderRequirements: [],
    });
  cash.instrumentConfigurationCid = exercised(tx, 'RegistrarService_CreateInstrumentConfiguration')[0].result.instrumentConfigurationCid;
  cash.instrumentId = { admin: cashAdmin, id: 'TESTUSD' };
  state.cash = cash;
});

// --- Governed action 1: the issuer asks to become a registrar ----------------
await step('issuer requests registrar service (governed)', async () => {
  const tx = await P[1].create(m1, R.RequestRegistrarService,
    { governanceParty: issuer, proposer: m1, operator, provider: operator });
  const proposalCid = tx.events.find((e) => e.kind === 'created').contractId;
  const decision = await decide(state, proposalCid, { label: 'RequestRegistrarService' });
  state.share = await acceptRegistrar(issuer);
  return { proposal: tx.updateId, decision };
});

// --- Governed action 2: share instrument and redemption policy ---------------
await step('launch fund (governed)', async () => {
  const tx = await P[1].create(m1, R.LaunchFund, {
    governanceParty: issuer, proposer: m1,
    registrarServiceCid: state.share.registrarServiceCid,
    shareId: 'FUNDSHARE',
    cashInstrument: state.cash.instrumentId,
    keepers: state.members,
    maxApprovalTtl: { microseconds: String(2 * 3600 * 1e6) },
    maxPerRedemption: '500.0', maxOutstanding: '600.0',
  });
  const proposalCid = tx.events.find((e) => e.kind === 'created').contractId;
  const decision = await decide(state, proposalCid, { label: 'LaunchFund' });
  // Executed through participant 3; wait until participant 1 has it too.
  const config = await eventually(async () =>
    (await P[1].query(issuer, R.InstrumentConfiguration)).find((c) => c.payload.registrar === issuer));
  state.share.instrumentConfigurationCid = config.contractId;
  state.share.instrumentId = { admin: issuer, id: 'FUNDSHARE' };
  state.policyCid = (await eventually(async () => (await P[1].query(issuer, T.Policy))[0])).contractId;
  return { proposal: tx.updateId, decision };
});

// --- Governed action 3: issue shares to the investors ------------------------
for (const [holder, amount] of [[investor, 400], [investor2, 100]]) {
  await step(`issue ${amount} FUNDSHARE to ${short(holder)} (governed)`, async () => {
    const extraArgs = issuerContext(state.share.instrumentConfigurationCid);
    const tx = await P[1].create(m1, R.OfferShares, {
      governanceParty: issuer, proposer: m1,
      factoryCid: state.share.allocationFactoryCid, shareId: 'FUNDSHARE',
      holder, amount: amount.toFixed(1), reference: 'initial subscription', extraArgs,
    });
    const proposalCid = tx.events.find((e) => e.kind === 'created').contractId;
    const decision = await decide(state, proposalCid, { label: 'OfferShares' });
    // The investor accepts on their own participant, with the instrument
    // configuration disclosed by the issuer's side.
    let offer;
    for (let i = 0; i < 30 && !offer; i++) {
      offer = (await P[4].query(holder, R.MintOffer)).find((c) => c.payload.mint.holder === holder);
      if (!offer) await new Promise((r) => setTimeout(r, 1000));
    }
    const disclosed = await disclose(P[1], issuer, [state.share.instrumentConfigurationCid]);
    const accepted = await P[4].exercise(holder, R.MintOffer, offer.contractId, 'MintOffer_Accept', { extraArgs }, { disclosed });
    return { proposal: tx.updateId, decision, accepted: accepted.updateId };
  });
}

// --- Governed action 4: the treasury takes delivery of cash ------------------
await step('fund treasury with 1000 TESTUSD (governed)', async () => {
  const extraArgs = issuerContext(state.cash.instrumentConfigurationCid);
  const offered = await P[4].exercise(cashAdmin, R.Factory, state.cash.allocationFactoryCid, 'AllocationFactory_OfferMint', {
    expectedAdmin: cashAdmin,
    mint: {
      instrumentId: state.cash.instrumentId, amount: '1000.0', holder: issuer, reference: 'treasury funding',
      requestedAt: iso(-5000), executeBefore: iso(24 * 3600e3), meta: { values: {} },
    },
    extraArgs,
  });
  const mintOfferCid = exercised(offered, 'AllocationFactory_OfferMint')[0].result.mintOfferCid;
  const tx = await P[1].create(m1, R.AcceptCash,
    { governanceParty: issuer, proposer: m1, mintOfferCid, amount: '1000.0', extraArgs });
  const proposalCid = tx.events.find((e) => e.kind === 'created').contractId;
  const disclosed = await disclose(P[4], cashAdmin, [state.cash.instrumentConfigurationCid]);
  const decision = await decide(state, proposalCid, { label: 'AcceptCash', disclosed });
  return { offered: offered.updateId, proposal: tx.updateId, decision };
});

console.log('Fund is set up on the DecMan network.');

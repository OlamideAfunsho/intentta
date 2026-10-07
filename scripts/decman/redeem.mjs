// Redemptions on the DecMan network, with evidence.
//
// The issuer is a decentralized party hosted by three participants, each
// with its own DecMan node. Approval is confirmed and executed through those
// nodes' REST APIs; the investor settles from a fourth participant.
//
//   node scripts/decman/redeem.mjs      -> evidence/decman-e2e.json, .md

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Ledger, created, entity } from '../../demo/lib/ledger.mjs';
import { T, terms as makeTerms } from '../../demo/lib/kit.mjs';
import {
  P, nodes, dm, confirmOn, pending, executeOn, disclose, issuerContext, transferContext, loadState, exercised, iso, short,
  currentPolicy, proposeApproval, cashDisclosures as cashDisclosuresFor, findApproval as findApprovalFor,
} from './lib.mjs';

const state = loadState();
const { issuer, investor, investor2, outsider, operator, cashAdmin, members, share, cash } = state;
const [m1, m2, m3] = members;
const net = { issuer, share, cash };
const evidence = {
  network: 'local Canton (Splice 0.6.12 build, protocol version 35), 4 participants, 1 synchronizer',
  decman: 'public.ecr.aws/dlc-link/decentralization-manager:v1.13.0, three nodes',
  startedAt: new Date().toISOString(),
  issuer: await dm(nodes[0], 'GET', '/decentralized-parties').then((r) => r.parties.find((p) => p.party_id === issuer)),
  governance: (await dm(nodes[0], 'GET', `/governance/state?party_id=${encodeURIComponent(issuer)}`)).state,
  hosting: {
    participant1: ['fund-issuer (decentralized)', short(m1)],
    participant2: ['fund-issuer (decentralized)', short(m2)],
    participant3: ['fund-issuer (decentralized)', short(m3)],
    participant4: [investor, investor2, outsider, operator, cashAdmin].map(short),
  },
  setup: Object.fromEntries(Object.entries(state.steps).filter(([k]) => k.includes('governed')).map(([k, v]) => [k, {
    confirmedOn: v.decision.confirmedOn || v.decision.confirm?.map((c) => c.node),
    executedOn: v.decision.executedOn || 'decman3',
    description: v.decision.asSeenByDecman3.description,
  }])),
  scenarios: [],
};

const sum = (xs) => xs.reduce((a, c) => a + Number(c.payload.amount), 0);
async function balances(ledger, party, token) {
  const hs = (await ledger.query(party, T.Holding)).filter(
    (c) => c.payload.owner === party && c.payload.registrar === token.registrar && c.payload.instrument.id === token.instrumentId.id);
  return { total: sum(hs), unlocked: sum(hs.filter((c) => c.payload.lock == null)), holdings: hs };
}
const snapshot = async () => {
  const [s, c, t] = await Promise.all([balances(P[4], investor, share), balances(P[4], investor, cash), balances(P[1], issuer, cash)]);
  const pick = ({ total, unlocked }) => ({ total, unlocked });
  return { investorShares: pick(s), investorCash: pick(c), issuerCash: pick(t) };
};
const policy = () => currentPolicy(state);
const propose = (intentCid, t) => proposeApproval(state, intentCid, t);
const cashDisclosures = () => cashDisclosuresFor(state);
const findApproval = (requestId) => findApprovalFor(state, requestId);

// The ledger transaction behind a DecMan call: the latest one on that
// member's participant that exercised the given choice.
async function txOf(ledger, party, choice) {
  const end = await ledger.ledgerEnd();
  const txs = await ledger.updates([party], Math.max(0, end - 40), end);
  const tx = [...txs].reverse().find((t) => exercised(t, choice).length);
  return tx && { updateId: tx.updateId, offset: tx.offset, effectiveAt: tx.effectiveAt, events: tx.events };
}
const ref = (tx) => tx && { updateId: tx.updateId, offset: tx.offset };
const names = (tx) => tx.events.map((e) => (e.kind === 'exercised' ? `exercise ${e.choice}` : `${e.kind} ${entity(e.templateId)}`));

async function rejected(label, promise) {
  try { await promise; } catch (e) { return { label, rejected: true, reason: String(e.message).replace(/\s+/g, ' ').slice(0, 320) }; }
  assert.fail(`${label}: expected a rejection`);
}

async function scenario(name, title, fn) {
  console.log(`\n== ${name}: ${title}`);
  const record = { name, title, steps: [] };
  const step = (label, data = {}) => { record.steps.push({ label, ...data }); console.log(`   - ${label}`); };
  await fn(step, record);
  evidence.scenarios.push(record);
}

// Investor, on participant 4.
async function request(requestId, shares, payout, validMs = 24 * 3600e3) {
  const t = makeTerms(net, { investor, requestId, shares, payout, expiresAt: iso(validMs) });
  const tx = await P[4].create(investor, T.Intent, { terms: t });
  return { t, tx, intentCid: created(tx, 'IntentTA.Redemption.Intent:InvestorIntent')[0].contractId };
}

async function approve(intentCid, t) {
  const proposed = await propose(intentCid, t);
  await confirmOn(nodes[0], state, proposed.proposalCid);
  await confirmOn(nodes[1], state, proposed.proposalCid);
  const action = await pending(nodes[2], state, proposed.proposalCid, (a) => a.can_execute);
  await executeOn(nodes[2], state, action, await cashDisclosures());
  return findApproval(t.requestId);
}
// Investor, on participant 4: settle. Disclosures come from the registrars'
// participants, as the Registry's off-ledger API would serve them.
async function redeem(approval, as = investor) {
  const shares = (await balances(P[4], investor, share)).holdings.filter((c) => c.payload.lock == null);
  const leg = (await P[4].query(cashAdmin, '#utility-registry-v0:Utility.Registry.V0.Holding.Allocation:DvpLegAllocation'))
    .find((c) => c.contractId === approval.payload.allocationCid);
  const disclosed = [
    ...(await disclose(P[1], issuer, [share.allocationFactoryCid, share.instrumentConfigurationCid])),
    ...(await disclose(P[4], cashAdmin, [cash.instrumentConfigurationCid, cash.transferRuleCid,
      ...(leg ? [leg.contractId, leg.payload.lockedHoldingCid] : [])])),
  ];
  return P[4].exercise(as, T.Approved, approval.contractId, 'ApprovedRedemption_Redeem', {
    shareHoldingCids: shares.map((c) => c.contractId),
    shareFactoryCid: share.allocationFactoryCid,
    burnExtraArgs: issuerContext(share.instrumentConfigurationCid),
    payoutExtraArgs: transferContext(cash),
  }, { disclosed });
}

// ---------------------------------------------------------------------------

await scenario('D1', '100 FUNDSHARE burned for 100 TESTUSD, approved through DecMan nodes', async (step, rec) => {
  const before = await snapshot();
  const { t, tx, intentCid } = await request('DM-001', 100, 100);
  step('investor creates InvestorIntent on participant 4', { tx: ref(tx) });

  const proposed = await propose(intentCid, t);
  step('member 1 creates ApproveRedemptionAction on participant 1', { tx: ref(proposed.tx), proposalCid: proposed.proposalCid });

  await confirmOn(nodes[0], state, proposed.proposalCid);
  step('member 1 confirms through DecMan node 1 (POST /governance/confirm)', { tx: ref(await txOf(P[1], m1, 'GovernanceRules_ConfirmAction')) });

  const one = await pending(nodes[1], state, proposed.proposalCid, (a) => a.confirmation_count === 1);
  step('DecMan node 2 lists the proposal with its terms, 1 of 2 confirmations', {
    decman: { action_label: one.action_label, description: one.description, confirmation_count: one.confirmation_count, can_execute: one.can_execute },
  });
  assert.equal(one.can_execute, false);
  step('execution with one confirmation is refused', await rejected('execute below threshold',
    executeOn(nodes[1], state, one, await cashDisclosures())));

  await confirmOn(nodes[1], state, proposed.proposalCid);
  step('member 2 confirms through DecMan node 2', { tx: ref(await txOf(P[2], m2, 'GovernanceRules_ConfirmAction')) });

  const ready = await pending(nodes[2], state, proposed.proposalCid, (a) => a.can_execute);
  await executeOn(nodes[2], state, ready, await cashDisclosures());
  const executed = await txOf(P[3], m3, 'GovernanceRules_ExecuteConfirmedAction');
  for (const choice of ['RedemptionPolicy_Reserve', 'AllocationFactory_Allocate', 'InvestorIntent_Approve']) {
    assert.equal(exercised(executed, choice).length, 1, `${choice} in the approval transaction`);
  }
  step('member 3 executes through DecMan node 3 (POST /governance/execute): request consumed, cash reserved, approval created in one transaction',
    { tx: ref(executed), events: names(executed) });

  const approval = await findApproval('DM-001');
  const afterApproval = await snapshot();
  assert.equal(afterApproval.issuerCash.unlocked, before.issuerCash.unlocked - 100);
  assert.deepEqual(afterApproval.investorShares, before.investorShares);

  const settled = await redeem(approval);
  for (const choice of ['AllocationFactory_OfferBurn', 'BurnOffer_Accept', 'Allocation_ExecuteTransfer']) {
    assert.equal(exercised(settled, choice).length, 1, `${choice} in the settlement transaction`);
  }
  const receiptCid = created(settled, 'IntentTA.Redemption.Receipt:RedemptionReceipt')[0].contractId;
  step('investor settles from participant 4, alone: burn offer created and accepted, cash transferred, receipt created in one transaction',
    { tx: ref(settled), submittedAs: { participant: 'participant4', actAs: [short(investor)] }, events: names(settled) });

  const after = await snapshot();
  assert.equal(after.investorShares.total, before.investorShares.total - 100);
  assert.equal(after.investorCash.total, before.investorCash.total + 100);
  assert.equal(after.issuerCash.total, before.issuerCash.total - 100);
  rec.balances = { before, afterApproval, after };

  step('replay of the settlement is rejected', await rejected('second redeem', redeem(approval)));

  const [receipt] = (await P[2].query(issuer, T.Receipt)).filter((r) => r.contractId === receiptCid);
  const released = await P[2].exercise(m2, T.Policy, (await policy()).contractId, 'RedemptionPolicy_ReleaseRedeemed',
    { actor: m2, slotCid: receipt.payload.slotCid, receiptCid }, { readAs: [issuer] });
  step('member 2, as keeper, releases the reservation budget against the receipt', { tx: ref(released) });
  assert.equal(Number((await policy()).payload.outstanding), 0);

  const audit = (await P[1].query(issuer, T.ExecutionResult)).map((c) => c.payload.actionLabel).sort();
  rec.decmanAuditTrail = audit;
  step(`DecMan audit trail on the ledger: ${audit.join(', ')}`);
});

await scenario('D2', 'Cancellation across participants: authorization ends on the investor node, cleanup runs on a committee node', async (step, rec) => {
  const { t, intentCid } = await request('DM-002', 50, 50);
  const approval = await approve(intentCid, t);
  step('approved 2-of-3 through DecMan nodes');
  const before = await snapshot();
  const cancelled = await P[4].exercise(investor, T.Approved, approval.contractId, 'ApprovedRedemption_Cancel', {});
  step('investor cancels the approval on participant 4', { tx: ref(cancelled) });
  step('settlement after cancellation is rejected', await rejected('redeem after cancel', redeem(approval)));
  const mid = await snapshot();
  assert.deepEqual(mid.investorShares, before.investorShares);
  assert.equal(mid.issuerCash.unlocked, before.issuerCash.unlocked, 'cash still locked after cancellation');

  const [cleanup] = await P[3].query(issuer, T.Cleanup);
  const cleaned = await P[3].exercise(m3, T.Cleanup, cleanup.contractId, 'ReservationCleanup_Release',
    { actor: m3, policyCid: (await policy()).contractId, extraArgs: transferContext(cash) },
    { readAs: [issuer], disclosed: await cashDisclosures() });
  step('member 3, as keeper, withdraws the reservation from participant 3: cash unlocked, budget returned', { tx: ref(cleaned) });
  const after = await snapshot();
  assert.equal(after.issuerCash.unlocked, before.issuerCash.unlocked + 50);
  assert.equal(Number((await policy()).payload.outstanding), 0);
  rec.balances = { before, afterCancel: mid, after };
});

await scenario('D3', 'Direct calls across participants are rejected', async (step) => {
  const { t, intentCid } = await request('DM-003', 20, 20);
  const approval = await approve(intentCid, t);
  const before = await snapshot();
  const leg = (await P[4].query(cashAdmin, '#utility-registry-v0:Utility.Registry.V0.Holding.Allocation:DvpLegAllocation'))
    .find((c) => c.contractId === approval.payload.allocationCid);
  const disclosed = await disclose(P[4], cashAdmin, [cash.instrumentConfigurationCid, cash.transferRuleCid, leg.contractId, leg.payload.lockedHoldingCid]);
  step('investor executing the cash allocation directly is rejected', await rejected('cash-only withdrawal',
    P[4].exercise(investor, T.Allocation, approval.payload.allocationCid, 'Allocation_ExecuteTransfer', { extraArgs: transferContext(cash) }, { disclosed })));
  step('a member redeeming from their own participant is rejected', await rejected('member redeem',
    P[1].exercise(m1, T.Approved, approval.contractId, 'ApprovedRedemption_Redeem', {
      shareHoldingCids: [], shareFactoryCid: share.allocationFactoryCid,
      burnExtraArgs: issuerContext(share.instrumentConfigurationCid), payoutExtraArgs: transferContext(cash),
    }, { readAs: [issuer] })));
  step('a single member exercising the policy as the issuer is rejected', await rejected('member acting as issuer',
    P[1].exercise(m1, T.Policy, (await policy()).contractId, 'RedemptionPolicy_SetLimits', {
      newKeepers: members, newMaxApprovalTtl: { microseconds: '3600000000' }, newMaxPerRedemption: '100000.0', newMaxOutstanding: '100000.0',
    }, { readAs: [issuer] })));
  assert.deepEqual(await snapshot(), before);
  const done = await redeem(approval);
  step('the investor then settles normally', { tx: ref(done) });
});

await scenario('D4', 'Privacy across participants: what each node holds', async (step, rec) => {
  const view = async (ledger, party) => {
    const end = await ledger.ledgerEnd();
    const acs = await ledger.activeContracts(Ledger.wildcard([party]));
    const txs = await ledger.updates([party], 0, end);
    return {
      activeKitContracts: [...new Set(acs.map((c) => entity(c.templateId)).filter((n) => n.startsWith('IntentTA.')))].sort(),
      transactions: txs.length,
      templatesInHistory: [...new Set(txs.flatMap((tx) => tx.events.map((e) => entity(e.templateId || ''))))].filter(Boolean).sort(),
    };
  };
  const views = {
    'participant4 / investor': await view(P[4], investor),
    'participant4 / investor2': await view(P[4], investor2),
    'participant4 / outsider': await view(P[4], outsider),
    'participant4 / cash admin': await view(P[4], cashAdmin),
    'participant4 / registry operator': await view(P[4], operator),
    'participant2 / issuer': await view(P[2], issuer),
    'participant2 / member2': await view(P[2], m2),
  };
  rec.views = views;
  const has = (v, name) => v.templatesInHistory.some((t) => t.endsWith(':' + name));
  const kit = (v) => v.templatesInHistory.filter((t) => t.startsWith('IntentTA.') || t.startsWith('Governance.'));

  // The investor's participant, for all the parties it hosts, never received
  // the issuer's policy, slots, proposals, votes, rules or audit records.
  for (const who of Object.keys(views).filter((k) => k.startsWith('participant4'))) {
    for (const hidden of ['RedemptionPolicy', 'ReservationSlot', 'ApproveRedemptionAction', 'GovernanceRules', 'GovernanceConfirmation', 'GovernanceExecutionResult']) {
      assert.ok(!has(views[who], hidden), `${who} history has no ${hidden}`);
    }
  }
  assert.deepEqual(kit(views['participant4 / investor2']), [], 'other investor sees no redemption');
  assert.deepEqual(kit(views['participant4 / outsider']), [], 'outsider sees no redemption');
  assert.deepEqual(kit(views['participant4 / cash admin']), [], 'cash admin sees no kit contract');
  assert.deepEqual(kit(views['participant4 / registry operator']), [], 'registry operator sees no kit contract');
  step("participant 4 holds no policy, slot, proposal, vote, rules or audit contract for any party it hosts");
  step('second investor, outsider, cash admin and registry operator hold no redemption contract', {});

  // Each committee member's participant hosts the issuer and so holds
  // everything the issuer is party to, including every investor's request.
  const issuerSees = views['participant2 / issuer'].templatesInHistory;
  for (const visible of ['InvestorIntent', 'ApprovedRedemption', 'RedemptionReceipt', 'RedemptionPolicy', 'ReservationSlot', 'ReservationCleanup', 'GovernanceRules']) {
    assert.ok(issuerSees.some((t) => t.endsWith(':' + visible)), `participant 2 holds ${visible}`);
  }
  step('participant 2, which hosts the issuer, holds requests, approvals, receipts, the policy, slots, cleanups and the rules', {
    templates: issuerSees.filter((t) => t.startsWith('IntentTA.') || t.startsWith('Governance.')),
  });
});

evidence.finishedAt = new Date().toISOString();
evidence.final = await snapshot();
writeFileSync('evidence/decman-e2e.json', JSON.stringify(evidence, null, 2) + '\n');

const md = ['# DecMan network evidence', '',
  `Run ${evidence.startedAt}. Generated by \`node scripts/decman/redeem.mjs\`; full record in \`decman-e2e.json\`.`, '',
  `- Network: ${evidence.network}.`, `- DecMan: ${evidence.decman}.`,
  `- Issuer: \`${short(issuer)}\`, a decentralized party with ${evidence.issuer.owners.length} owner keys and threshold ${evidence.issuer.threshold}, hosted on ${evidence.issuer.participants.length} participants.`,
  `- Governance: stock \`GovernanceRules\` (${evidence.governance.package_ref}), ${evidence.governance.members.length} members, threshold ${evidence.governance.threshold}.`, '',
  '## Governed setup', '', 'Each step was confirmed on DecMan nodes 1 and 2 and executed on node 3.', ''];
for (const [k, v] of Object.entries(evidence.setup)) md.push(`- ${k.replace(' (governed)', '')}: ${v.description}`);
md.push('');
for (const s of evidence.scenarios) {
  md.push(`## ${s.name}. ${s.title}`, '');
  for (const st of s.steps) md.push(`- ${st.label}${st.tx ? ` (\`${st.tx.updateId}\`)` : st.rejected ? ' (rejected)' : ''}`);
  md.push('');
}
writeFileSync('evidence/decman-e2e.md', md.join('\n'));
console.log(`\n${evidence.scenarios.length} scenarios passed. Evidence in evidence/decman-e2e.json`);

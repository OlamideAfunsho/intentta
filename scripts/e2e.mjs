// End-to-end run against a real Canton ledger. Produces the transaction
// evidence in evidence/local-e2e.json and a readable summary next to it.
//
// Every scenario asserts its outcome; the script exits non-zero if any
// assertion fails, so a green run is the evidence.
//
//   node scripts/e2e.mjs            (expects .local/localnet.json from bootstrap)

import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as kit from '../demo/lib/kit.mjs';
import { Ledger, exercised, created, entity } from '../demo/lib/ledger.mjs';

const L = new Ledger({ userId: 'intentta-e2e' });
const net = kit.loadNet();
const [m1, m2, m3] = net.members;
const evidence = { ledger: L.baseUrl, startedAt: new Date().toISOString(), parties: {}, scenarios: [] };
for (const k of ['issuer', 'investor', 'investor2', 'outsider', 'operator', 'cashAdmin']) evidence.parties[k] = net[k];
evidence.parties.members = net.members;

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txRef = (tx) => ({ updateId: tx.updateId, offset: tx.offset, effectiveAt: tx.effectiveAt });

async function rejected(label, promise) {
  try {
    await promise;
  } catch (e) {
    return { label, rejected: true, code: e.code || String(e.status), reason: String(e.message).slice(0, 400) };
  }
  assert.fail(`${label}: expected the ledger to reject this, but it was accepted`);
}

async function snapshot() {
  const b = async (p, tok) => kit.balances(L, p, tok);
  return {
    investorShares: await b(net.investor, net.share),
    investorCash: await b(net.investor, net.cash),
    issuerCash: await b(net.issuer, net.cash),
  };
}

async function scenario(name, title, fn) {
  process.stdout.write(`\n== ${name}: ${title}\n`);
  const record = { name, title, steps: [] };
  const step = (label, data) => {
    record.steps.push({ label, ...data });
    process.stdout.write(`   - ${label}\n`);
  };
  await fn(step, record);
  record.result = 'passed';
  evidence.scenarios.push(record);
}

// ---------------------------------------------------------------------------

await scenario('S1', '100 FundShare burned for 100 TestUSD in one transaction', async (step, rec) => {
  const before = await snapshot();
  const t = kit.terms(net, { investor: net.investor, requestId: 'E2E-001', shares: 100, payout: 100, expiresAt: inHours(24) });

  const req = await kit.request(L, t);
  step('investor creates InvestorIntent', { tx: txRef(req.tx), intentCid: req.intentCid });
  assert.deepEqual(await kit.balances(L, net.investor, net.share), before.investorShares, 'request must not move shares');

  const proposed = await kit.propose(L, net, m1, req.intentCid, t);
  step('member 1 proposes ApproveRedemptionAction', { tx: txRef(proposed.tx), proposalCid: proposed.proposalCid });
  const c1 = await kit.confirm(L, net, m1, proposed.proposalCid);
  step('member 1 confirms (1 of 3)', { tx: txRef(c1.tx) });

  step('execution with 1 of 3 confirmations is rejected', await rejected(
    'execute below threshold', kit.execute(L, net, m1, proposed.proposalCid, [c1.confirmationCid])));

  const c2 = await kit.confirm(L, net, m2, proposed.proposalCid);
  step('member 2 confirms (2 of 3)', { tx: txRef(c2.tx) });

  const executed = await kit.execute(L, net, m3, proposed.proposalCid, [c1.confirmationCid, c2.confirmationCid]);
  const names = executed.tx.events.map((e) => (e.kind === 'exercised' ? `exercise ${e.choice}` : `${e.kind} ${entity(e.templateId)}`));
  assert.ok(exercised(executed.tx, 'InvestorIntent_Approve').length === 1, 'request consumed in the approval tx');
  assert.ok(exercised(executed.tx, 'AllocationFactory_Allocate').length === 1, 'cash reserved in the approval tx');
  assert.ok(created(executed.tx, 'IntentTA.Redemption.Approved:ApprovedRedemption').length === 1, 'approval created in the approval tx');
  step('member 3 executes: request consumed, cash reserved, approval created together', { tx: txRef(executed.tx), events: names });

  const afterApproval = await snapshot();
  assert.equal(afterApproval.issuerCash.unlocked, before.issuerCash.unlocked - 100, 'payout is locked');
  assert.equal(afterApproval.issuerCash.total, before.issuerCash.total, 'issuer still owns the cash');
  assert.deepEqual(afterApproval.investorShares, before.investorShares, 'investor keeps shares until settlement');

  const approval = (await kit.approvals(L, net.investor)).find((a) => a.payload.terms.requestId === 'E2E-001');
  assert.ok(approval, 'investor sees the approval');

  // The investor completes alone: actAs investor only, no readAs, with
  // Registry disclosures. No committee member takes part.
  const redeemed = await kit.redeem(L, net, net.investor, approval);
  const rnames = redeemed.tx.events.map((e) => (e.kind === 'exercised' ? `exercise ${e.choice}` : `${e.kind} ${entity(e.templateId)}`));
  for (const choice of ['ApprovedRedemption_Redeem', 'AllocationFactory_OfferBurn', 'BurnOffer_Accept', 'Allocation_ExecuteTransfer']) {
    assert.equal(exercised(redeemed.tx, choice).length, 1, `${choice} is in the settlement transaction`);
  }
  assert.ok(redeemed.receiptCid, 'receipt created in the settlement transaction');
  step('investor redeems: burn offer created and accepted, cash transferred, receipt created in one transaction', {
    tx: txRef(redeemed.tx), receiptCid: redeemed.receiptCid, submittedAs: { actAs: [net.investor], readAs: [] }, events: rnames,
  });

  const after = await snapshot();
  assert.equal(after.investorShares.total, before.investorShares.total - 100, '100 shares burned');
  assert.equal(after.investorCash.total, before.investorCash.total + 100, '100 cash paid');
  assert.equal(after.issuerCash.total, before.issuerCash.total - 100, 'issuer cash reduced by 100');
  rec.balances = { before, afterApproval, after };

  step('replay: redeeming the same approval again is rejected', await rejected('second redeem', kit.redeem(L, net, net.investor, approval)));
  assert.deepEqual(await snapshot(), after, 'replay changed nothing');

  const [receipt] = (await L.query(net.investor, kit.T.Receipt)).filter((r) => r.contractId === redeemed.receiptCid);
  const released = await kit.releaseRedeemed(L, net, m2, receipt);
  step('keeper returns the reservation budget against the receipt', { tx: txRef(released.tx) });
  const p = await kit.policy(L, net);
  assert.equal(Number(p.payload.outstanding), 0);
});

await scenario('S2', 'Failed settlement: payout unavailable, shares are not burned', async (step, rec) => {
  const t = kit.terms(net, { investor: net.investor, requestId: 'E2E-002', shares: 50, payout: 50, expiresAt: inHours(24) });
  const req = await kit.request(L, t);
  const { approval } = await kit.approve(L, net, req.intentCid, t);
  const before = await snapshot();

  // The issuer withdraws the allocation directly, outside the kit.
  const disclosed = await kit.registryDisclosures(L, net.cash);
  const withdrawn = await L.exercise(net.issuer, kit.T.Allocation, approval.payload.allocationCid, 'Allocation_Withdraw',
    { extraArgs: kit.transferArgs(net, net.cash) }, { disclosed });
  step('issuer withdraws the cash allocation directly', { tx: txRef(withdrawn.tx || withdrawn) });

  step('redeem is rejected as a whole', await rejected('redeem without payout', kit.redeem(L, net, net.investor, approval)));
  const after = await snapshot();
  assert.deepEqual(after.investorShares, before.investorShares, 'shares not burned');
  assert.deepEqual(after.investorCash, before.investorCash, 'nothing paid');
  rec.balances = { before, after };

  const cancelled = await kit.cancelApproval(L, net.investor, approval.contractId);
  step('investor cancels the unusable approval', { tx: txRef(cancelled.tx) });
  const cleaned = await kit.releaseSlotOnly(L, net, m1, cancelled.cleanupCid);
  step('keeper returns the budget (allocation already gone)', { tx: txRef(cleaned.tx) });
});

await scenario('S3', 'Cancellation: authorization ends at once, cash cleanup is a separate step', async (step, rec) => {
  const t = kit.terms(net, { investor: net.investor, requestId: 'E2E-003', shares: 50, payout: 50, expiresAt: inHours(24) });
  const req = await kit.request(L, t);
  const { approval } = await kit.approve(L, net, req.intentCid, t);
  const before = await snapshot();

  const cancelled = await kit.cancelApproval(L, net.investor, approval.contractId);
  step('investor cancels the approval', { tx: txRef(cancelled.tx), cleanupCid: cancelled.cleanupCid });
  step('redeem after cancel is rejected', await rejected('redeem after cancel', kit.redeem(L, net, net.investor, approval)));

  const mid = await snapshot();
  assert.equal(mid.issuerCash.unlocked, before.issuerCash.unlocked, 'cash is still locked after cancellation');
  assert.equal(Number((await kit.policy(L, net)).payload.outstanding), 50, 'slot still open after cancellation');

  const cleaned = await kit.releaseCleanup(L, net, m3, cancelled.cleanupCid);
  step('keeper withdraws the reservation and returns the budget', { tx: txRef(cleaned.tx) });
  const after = await snapshot();
  assert.equal(after.issuerCash.unlocked, before.issuerCash.unlocked + 50, 'cash unlocked after cleanup');
  assert.equal(Number((await kit.policy(L, net)).payload.outstanding), 0);
  assert.deepEqual(after.investorShares, before.investorShares);
  rec.balances = { before, afterCancel: mid, after };
});

await scenario('S4', 'Race: cancel and redeem submitted concurrently, exactly one wins', async (step, rec) => {
  rec.rounds = [];
  for (let round = 1; round <= 6; round++) {
    const id = `E2E-004-${round}`;
    const t = kit.terms(net, { investor: net.investor, requestId: id, shares: 10, payout: 10, expiresAt: inHours(24) });
    const req = await kit.request(L, t);
    const { approval } = await kit.approve(L, net, req.intentCid, t);
    const before = await snapshot();

    // Both commands are fully prepared first. In the first three rounds they
    // are submitted in the same tick; in the last three the redeem gets a
    // short head start, so that both outcomes of the race are exercised.
    const headStartMs = [0, 0, 0, 200, 500, 900][round - 1];
    const submitRedeem = await kit.prepareRedeem(L, net, net.investor, approval);
    const redeemInFlight = submitRedeem();
    if (headStartMs) await sleep(headStartMs);
    const cancelInFlight = kit.cancelApproval(L, net.investor, approval.contractId);
    const outcomes = await Promise.allSettled([redeemInFlight, cancelInFlight]);
    const [redeem, cancel] = outcomes.map((o) => o.status === 'fulfilled');
    assert.equal(Number(redeem) + Number(cancel), 1, `round ${round}: exactly one of redeem/cancel must commit`);
    const after = await snapshot();
    if (redeem) {
      assert.equal(after.investorShares.total, before.investorShares.total - 10);
      assert.equal(after.investorCash.total, before.investorCash.total + 10);
      const [receipt] = (await L.query(net.investor, kit.T.Receipt)).filter((r) => r.payload.terms.requestId === id);
      await kit.releaseRedeemed(L, net, m1, receipt);
    } else {
      assert.deepEqual(after.investorShares, before.investorShares);
      assert.deepEqual(after.investorCash, before.investorCash);
      await kit.releaseCleanup(L, net, m1, outcomes[1].value.cleanupCid);
    }
    const loser = outcomes[redeem ? 1 : 0].reason;
    rec.rounds.push({ round, redeemHeadStartMs: headStartMs, winner: redeem ? 'redeem' : 'cancel', loserRejectedWith: loser?.code || String(loser?.message).slice(0, 160) });
    step(`round ${round} (redeem head start ${headStartMs} ms): ${redeem ? 'redeem' : 'cancel'} committed, the other was rejected`, {});
  }
  assert.equal(Number((await kit.policy(L, net)).payload.outstanding), 0);
});

await scenario('S5', 'Direct calls: cash-only withdrawal and third-party redemption are rejected', async (step) => {
  const t = kit.terms(net, { investor: net.investor, requestId: 'E2E-005', shares: 20, payout: 20, expiresAt: inHours(24) });
  const req = await kit.request(L, t);
  const { approval } = await kit.approve(L, net, req.intentCid, t);
  const before = await snapshot();
  const disclosed = [
    ...(await kit.registryDisclosures(L, net.cash)),
    ...(await kit.allocationDisclosures(L, net, approval.payload.allocationCid)),
  ];
  const args = { extraArgs: kit.transferArgs(net, net.cash) };

  step('investor executing the cash allocation directly is rejected', await rejected('cash-only withdrawal',
    L.exercise(net.investor, kit.T.Allocation, approval.payload.allocationCid, 'Allocation_ExecuteTransfer', args, { disclosed })));
  step('outsider redeeming the approval is rejected', await rejected('third-party redeem',
    kit.redeem(L, net, net.outsider, approval)));
  step('investor approving their own new request is rejected', await (async () => {
    const t2 = kit.terms(net, { investor: net.investor, requestId: 'E2E-005b', shares: 1, payout: 1, expiresAt: inHours(24) });
    const r2 = await kit.request(L, t2);
    const out = await rejected('self-approval', L.exercise(net.investor, kit.T.Intent, r2.intentCid, 'InvestorIntent_Approve',
      { slotCid: approval.payload.slotCid, allocationCid: approval.payload.allocationCid }));
    await kit.cancelRequest(L, net.investor, r2.intentCid);
    return out;
  })());
  assert.deepEqual(await snapshot(), before, 'rejected calls changed nothing');

  const cancelled = await kit.cancelApproval(L, net.investor, approval.contractId);
  await kit.releaseCleanup(L, net, m1, cancelled.cleanupCid);
});

await scenario('S6', 'Bounded expiry: an approval cannot outlive the investor deadline', async (step) => {
  const t = kit.terms(net, { investor: net.investor, requestId: 'E2E-006', shares: 5, payout: 5, expiresAt: inSeconds(25) });
  const req = await kit.request(L, t);
  const { approval } = await kit.approve(L, net, req.intentCid, t);
  assert.equal(approval.payload.expiresAt, approval.payload.terms.expiresAt, 'approval expiry equals the investor deadline');
  step('approval expires with the investor deadline', { expiresAt: approval.payload.expiresAt });
  const before = await snapshot();
  await sleep(Math.max(0, new Date(t.expiresAt).getTime() - Date.now()) + 3000);
  step('redeem after expiry is rejected', await rejected('redeem after expiry', kit.redeem(L, net, net.investor, approval)));
  assert.deepEqual((await snapshot()).investorShares, before.investorShares);
  const expired = await kit.expire(L, net, m2, approval.contractId);
  step('keeper expires the approval', { tx: txRef(expired.tx) });
  const cleaned = await kit.releaseCleanup(L, net, m2, expired.cleanupCid);
  step('keeper returns cash and budget', { tx: txRef(cleaned.tx) });
});

await scenario('S7', 'Privacy: party-scoped contract and transaction views', async (step, rec) => {
  const end = await L.ledgerEnd();
  const kitEntities = (events) => events
    .filter((e) => (e.templateId || '').includes('IntentTA.Redemption') || ['ApprovedRedemption_Redeem', 'InvestorIntent_Approve'].includes(e.choice))
    .length;
  const view = async (party) => {
    const acs = await L.activeContracts(Ledger.wildcard([party]));
    const txs = await L.updates([party], 0, end);
    const kitContracts = acs.filter((c) => c.templateId.includes('IntentTA.Redemption'));
    return {
      activeContracts: acs.length,
      kitContracts: kitContracts.map((c) => entity(c.templateId)).sort(),
      transactions: txs.length,
      kitEvents: txs.reduce((n, tx) => n + kitEntities(tx.events), 0),
      templatesSeen: [...new Set(txs.flatMap((tx) => tx.events.map((e) => entity(e.templateId || ''))))].sort(),
    };
  };
  const views = {};
  for (const who of ['investor', 'investor2', 'outsider', 'cashAdmin', 'operator', 'issuer']) views[who] = await view(net[who]);
  views.member1 = await view(m1);
  rec.views = views;

  assert.equal(views.outsider.kitEvents, 0, 'outsider sees no redemption events');
  assert.equal(views.outsider.kitContracts.length, 0);
  assert.equal(views.investor2.kitEvents, 0, 'another investor sees no redemption events');
  assert.equal(views.investor2.kitContracts.length, 0);
  assert.equal(views.operator.kitEvents, 0, 'registry operator sees no redemption contracts');
  assert.ok(views.investor.kitEvents > 0);
  for (const hidden of ['IntentTA.Redemption.Policy:RedemptionPolicy', 'IntentTA.Redemption.Cleanup:ReservationCleanup']) {
    assert.ok(!views.investor.kitContracts.includes(hidden), `investor does not hold ${hidden}`);
  }
  // The investor's transaction history must not contain the issuer's policy,
  // slots, committee proposals, votes or rules, not even as witnessed events.
  for (const hidden of ['RedemptionPolicy', 'ReservationSlot', 'ApproveRedemptionAction', 'GovernanceRules', 'GovernanceConfirmation', 'GovernanceExecutionResult']) {
    assert.ok(!views.investor.templatesSeen.some((t) => t.endsWith(':' + hidden)), `investor history has no ${hidden}`);
  }
  assert.ok(!views.cashAdmin.templatesSeen.some((t) => t.startsWith('IntentTA.')), 'cash admin history has no kit contracts');
  step('investor transaction history contains no policy, slot, proposal, vote or rules contract', {});
  step('outsider, other investor and registry operator see no redemption contracts or events', {});
  step('investor sees only their own requests, approvals and receipts', { kitContracts: views.investor.kitContracts });
  step('issuer (hosted on every committee member participant) sees all issuer-side contracts', { kitContracts: [...new Set(views.issuer.kitContracts)] });
});

evidence.finishedAt = new Date().toISOString();
evidence.final = await snapshot();
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/local-e2e.json', JSON.stringify(evidence, null, 2) + '\n');

const lines = ['# Local end-to-end evidence', '', `Ledger: \`${evidence.ledger}\` (Canton sandbox, Daml SDK 3.4.11). Run: ${evidence.startedAt}.`, '',
  'Generated by `node scripts/e2e.mjs`. Update ids are Canton transaction ids on the local ledger;', 'the full record, with party ids and events, is in `local-e2e.json`.', ''];
for (const s of evidence.scenarios) {
  lines.push(`## ${s.name}. ${s.title}`, '');
  for (const st of s.steps) {
    const ref = st.tx ? ` — \`${st.tx.updateId}\` @ offset ${st.tx.offset}` : st.rejected ? ` — rejected: \`${st.code}\`` : '';
    lines.push(`- ${st.label}${ref}`);
  }
  lines.push('');
}
writeFileSync('evidence/local-e2e.md', lines.join('\n'));
console.log(`\nAll ${evidence.scenarios.length} scenarios passed. Evidence written to evidence/local-e2e.json`);

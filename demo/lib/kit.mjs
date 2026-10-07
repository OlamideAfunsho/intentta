// Off-ledger helpers for the redemption kit: template ids, Registry choice
// contexts and one function per workflow step. Each function states which
// party it submits as, and nothing here holds state between calls.

import { readFileSync } from 'node:fs';
import { Ledger, created, exercised } from './ledger.mjs';

const KIT = '#intentta-redemption-v1:IntentTA.Redemption';
export const T = {
  Intent: `${KIT}.Intent:InvestorIntent`,
  Approved: `${KIT}.Approved:ApprovedRedemption`,
  Receipt: `${KIT}.Receipt:RedemptionReceipt`,
  Policy: `${KIT}.Policy:RedemptionPolicy`,
  Slot: `${KIT}.Reservation:ReservationSlot`,
  Cleanup: `${KIT}.Cleanup:ReservationCleanup`,
  ApproveAction: `${KIT}.Action:ApproveRedemptionAction`,
  RevokeAction: `${KIT}.Action:RevokeRedemptionAction`,
  // DecMan
  Rules: '#governance-core-v1:Governance.Rules:GovernanceRules',
  Confirmation: '#governance-core-v1:Governance.Confirmation:GovernanceConfirmation',
  ExecutionResult: '#governance-core-v1:Governance.ExecutionResult:GovernanceExecutionResult',
  GovernableAction: '#governance-action-v1:Governance.Action:GovernableAction',
  // DA Registry
  Holding: '#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding',
  RegistryFactory: '#utility-registry-app-v0:Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory',
  ExecutedBurn: '#utility-registry-app-v0:Utility.Registry.App.V0.Model.Burn:ExecutedBurn',
  DvpLegAllocation: '#utility-registry-v0:Utility.Registry.V0.Holding.Allocation:DvpLegAllocation',
  // Token standard
  Allocation: '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation',
  AllocationFactory:
    '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory',
};

export function loadNet(path = process.env.LOCALNET_FILE || '.local/localnet.json') {
  const net = JSON.parse(readFileSync(path, 'utf8'));
  // On a network with several participants, an instrument's reference data
  // is read on its registrar's participant. `registryUrl` names it; without
  // one, the caller's own ledger is used.
  for (const token of [net.share, net.cash]) {
    if (token.registryUrl) token.ledger = new Ledger({ baseUrl: token.registryUrl, userId: process.env.LEDGER_USER });
  }
  return net;
}

export const dec = (n) => Number(n).toFixed(10);
const cidValue = (cid) => ({ tag: 'AV_ContractId', value: cid });
const listValue = (xs) => ({ tag: 'AV_List', value: xs });
const noMeta = { values: {} };

// --- Registry choice contexts ----------------------------------------------
// In production these, and the matching disclosed contracts, are served by
// the Registry's off-ledger token-standard API. Locally they are derived
// from the bootstrap output, reading as the instrument's registrar.

export function burnArgs(net) {
  const k = net.contextKeys;
  return {
    context: {
      values: {
        [k.instrumentConfiguration]: cidValue(net.share.instrumentConfigurationCid),
        [k.issuerCredentials]: listValue([]),
      },
    },
    meta: noMeta,
  };
}

export function transferArgs(net, token) {
  const k = net.contextKeys;
  const values = {
    [k.instrumentConfiguration]: cidValue(token.instrumentConfigurationCid),
    [k.issuerCredentials]: listValue((token.providerCredentialCids || []).map(cidValue)),
    [k.transferRule]: cidValue(token.transferRuleCid),
    [k.senderCredentials]: listValue([]),
    [k.receiverCredentials]: listValue([]),
  };
  // Present only when the provider takes part in app rewards.
  if (token.appRewardConfigurationCid) values[k.appRewardConfiguration] = cidValue(token.appRewardConfigurationCid);
  if (token.featuredAppRightCid) values[k.featuredAppRight] = cidValue(token.featuredAppRightCid);
  return { context: { values }, meta: noMeta };
}

// Reference data of one instrument, disclosed by its registrar.
export async function registryDisclosures(L, token) {
  const ids = [
    token.allocationFactoryCid,
    token.instrumentConfigurationCid,
    token.transferRuleCid,
    token.appRewardConfigurationCid,
    token.featuredAppRightCid,
    ...(token.providerCredentialCids || []),
  ].filter(Boolean);
  return (await (token.ledger || L).disclosures(token.registrar, ids)).disclosed;
}

// The allocation and the holding it locks, disclosed by the cash registrar.
export async function allocationDisclosures(L, net, allocationCid) {
  const ledger = net.cash.ledger || L;
  const legs = await ledger.query(net.cash.registrar, T.DvpLegAllocation, { blobs: true });
  const leg = legs.find((c) => c.contractId === allocationCid);
  if (!leg) return [];
  const { disclosed } = await ledger.disclosures(net.cash.registrar, [allocationCid, leg.payload.lockedHoldingCid]);
  return disclosed;
}

// --- Party-scoped views -----------------------------------------------------

export async function holdings(L, party, token) {
  const all = await L.query(party, T.Holding);
  return all.filter(
    (c) =>
      c.payload.owner === party &&
      c.payload.registrar === token.registrar &&
      c.payload.instrument.id === token.instrumentId.id,
  );
}

export async function balances(L, party, token) {
  const hs = await holdings(L, party, token);
  const sum = (xs) => xs.reduce((a, c) => a + Number(c.payload.amount), 0);
  return { total: sum(hs), unlocked: sum(hs.filter((c) => c.payload.lock == null)) };
}

export async function policy(L, net) {
  const [p] = await L.query(net.issuer, T.Policy);
  return p;
}

// --- Workflow steps ---------------------------------------------------------

export function terms(net, { investor, requestId, shares, payout, recipient, expiresAt }) {
  return {
    issuer: net.issuer,
    investor,
    shareInstrument: net.share.instrumentId,
    cashInstrument: net.cash.instrumentId,
    shareQuantity: dec(shares),
    payoutAmount: dec(payout),
    payoutRecipient: recipient || investor,
    expiresAt,
    requestId,
  };
}

// Investor: file a redemption request.
export async function request(L, t) {
  const tx = await L.create(t.investor, T.Intent, { terms: t });
  return { tx, intentCid: created(tx, 'IntentTA.Redemption.Intent:InvestorIntent')[0].contractId };
}

// Committee member: propose approval of a request. Reads as the issuer,
// which every committee member's participant hosts.
export async function propose(L, net, member, intentCid, t) {
  const p = await policy(L, net);
  const cash = (await holdings(L, net.issuer, net.cash)).filter((c) => c.payload.lock == null);
  const tx = await L.create(member, T.ApproveAction, {
    governanceParty: net.issuer,
    proposer: member,
    intentCid,
    terms: t,
    policyCid: p.contractId,
    cashFactoryCid: net.cash.allocationFactoryCid,
    cashHoldingCids: cash.map((c) => c.contractId),
    allocateExtraArgs: transferArgs(net, net.cash),
  });
  return { tx, proposalCid: created(tx, 'IntentTA.Redemption.Action:ApproveRedemptionAction')[0].contractId };
}

// Committee member: confirm a proposal. This is the same ledger command the
// DecMan service submits for POST /governance/confirm (core_domain).
export async function confirm(L, net, member, proposalCid) {
  const tx = await L.exercise(
    member, T.Rules, net.rulesCid, 'GovernanceRules_ConfirmAction',
    { confirmer: member, actionProposalCid: proposalCid },
    { readAs: [net.issuer] },
  );
  return { tx, confirmationCid: exercised(tx, 'GovernanceRules_ConfirmAction')[0].result.confirmationCid };
}

// Committee member: execute a confirmed proposal. Same command as DecMan's
// POST /governance/execute (core_domain), including the disclosed contracts.
export async function execute(L, net, member, proposalCid, confirmationCids) {
  const disclosed = await registryDisclosures(L, net.cash);
  const tx = await L.exercise(
    member, T.Rules, net.rulesCid, 'GovernanceRules_ExecuteConfirmedAction',
    { executor: member, actionProposalCid: proposalCid, confirmations: confirmationCids },
    { readAs: [net.issuer], disclosed },
  );
  return { tx };
}

// The investor's approvals, as the investor sees them.
export function approvals(L, investor) {
  return L.query(investor, T.Approved);
}

// Investor: burn and get paid, in one transaction. Submitted by the investor
// alone, with Registry disclosures; no committee member or issuer service
// takes part.
export async function redeem(L, net, investor, approval, extra = {}) {
  return (await prepareRedeem(L, net, investor, approval))(extra);
}

// Gather everything the settlement needs and return a function that submits
// it. Splitting the two lets a caller put the command in flight at a chosen
// moment, which the race test uses.
export async function prepareRedeem(L, net, investor, approval) {
  const shares = (await holdings(L, investor, net.share)).filter((c) => c.payload.lock == null);
  const disclosed = [
    ...(await registryDisclosures(L, net.share)),
    ...(await registryDisclosures(L, net.cash)),
    ...(await allocationDisclosures(L, net, approval.payload.allocationCid)),
  ];
  return async (extra = {}) => {
    const tx = await L.exercise(
      investor, T.Approved, approval.contractId, 'ApprovedRedemption_Redeem',
      {
        shareHoldingCids: shares.map((c) => c.contractId),
        shareFactoryCid: net.share.allocationFactoryCid,
        burnExtraArgs: burnArgs(net),
        payoutExtraArgs: transferArgs(net, net.cash),
      },
      { disclosed, ...extra },
    );
    return { tx, receiptCid: created(tx, 'IntentTA.Redemption.Receipt:RedemptionReceipt')[0]?.contractId };
  };
}

export async function cancelRequest(L, investor, intentCid) {
  return { tx: await L.exercise(investor, T.Intent, intentCid, 'InvestorIntent_Cancel', {}) };
}

export async function cancelApproval(L, investor, approvedCid, extra = {}) {
  const tx = await L.exercise(investor, T.Approved, approvedCid, 'ApprovedRedemption_Cancel', {}, extra);
  return { tx, cleanupCid: exercised(tx, 'ApprovedRedemption_Cancel')[0].result };
}

// Keeper: close an approval after its deadline.
export async function expire(L, net, keeper, approvedCid) {
  const tx = await L.exercise(
    keeper, T.Approved, approvedCid, 'ApprovedRedemption_Expire', { actor: keeper }, { readAs: [net.issuer] },
  );
  return { tx, cleanupCid: exercised(tx, 'ApprovedRedemption_Expire')[0].result };
}

// Keeper: withdraw the reservation of a cancelled approval and return budget.
export async function releaseCleanup(L, net, keeper, cleanupCid) {
  const p = await policy(L, net);
  const disclosed = await registryDisclosures(L, net.cash);
  const tx = await L.exercise(
    keeper, T.Cleanup, cleanupCid, 'ReservationCleanup_Release',
    { actor: keeper, policyCid: p.contractId, extraArgs: transferArgs(net, net.cash) },
    { readAs: [net.issuer], disclosed },
  );
  return { tx };
}

// Keeper: return budget when the allocation no longer exists.
export async function releaseSlotOnly(L, net, keeper, cleanupCid) {
  const p = await policy(L, net);
  const tx = await L.exercise(
    keeper, T.Cleanup, cleanupCid, 'ReservationCleanup_ReleaseSlotOnly',
    { actor: keeper, policyCid: p.contractId },
    { readAs: [net.issuer] },
  );
  return { tx };
}

// Keeper: return the budget of a settled redemption against its receipt.
export async function releaseRedeemed(L, net, keeper, receipt) {
  const p = await policy(L, net);
  const tx = await L.exercise(
    keeper, T.Policy, p.contractId, 'RedemptionPolicy_ReleaseRedeemed',
    { actor: keeper, slotCid: receipt.payload.slotCid, receiptCid: receipt.contractId },
    { readAs: [net.issuer] },
  );
  return { tx };
}

// Propose, confirm 2-of-3 and execute; returns the investor's new approval.
export async function approve(L, net, intentCid, t) {
  const [m1, m2, m3] = net.members;
  const proposed = await propose(L, net, m1, intentCid, t);
  const c1 = await confirm(L, net, m1, proposed.proposalCid);
  const c2 = await confirm(L, net, m2, proposed.proposalCid);
  const executed = await execute(L, net, m3, proposed.proposalCid, [c1.confirmationCid, c2.confirmationCid]);
  const approval = (await approvals(L, t.investor)).find((a) => a.payload.terms.requestId === t.requestId);
  return { proposed, confirmations: [c1, c2], executed, approval };
}

export { Ledger };

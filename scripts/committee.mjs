// Committee tooling for the local demo. Each invocation submits one ledger
// command as one committee member and exits; nothing stays running.
//
// The confirm and execute commands are exactly what the DecMan service
// submits for a custom action (governance_type "core_domain"): they exercise
// GovernanceRules_ConfirmAction and GovernanceRules_ExecuteConfirmedAction
// on the stock governance-core-v1 contract. See docs/DECMAN.md for the
// equivalent DecMan REST calls.
//
//   node scripts/committee.mjs list
//   node scripts/committee.mjs propose <requestId> [--as 1]
//   node scripts/committee.mjs confirm <requestId> [--as 2]
//   node scripts/committee.mjs execute <requestId> [--as 3]
//   node scripts/committee.mjs approve <requestId>        (propose, confirm x2, execute)
//   node scripts/committee.mjs housekeeping [--as 1]      (release settled, cancelled, expired)

import * as kit from '../demo/lib/kit.mjs';
import { Ledger } from '../demo/lib/ledger.mjs';

const L = new Ledger({ userId: 'intentta-committee' });
const net = kit.loadNet();
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const [command, requestId] = argv;
const member = (n) => {
  const m = net.members[Number(n) - 1];
  if (!m) throw new Error(`--as must be 1..${net.members.length}`);
  return m;
};
const short = (p) => p.split('::')[0];

async function findRequest(id) {
  const found = (await L.query(net.issuer, kit.T.Intent)).filter((c) => c.payload.terms.requestId === id);
  if (found.length !== 1) throw new Error(`expected one pending request "${id}", found ${found.length}`);
  return found[0];
}

async function findProposal(id) {
  const found = (await L.query(net.issuer, kit.T.ApproveAction)).filter((c) => c.payload.terms.requestId === id);
  if (!found.length) throw new Error(`no proposal for request "${id}"`);
  return found[found.length - 1];
}

async function confirmationsFor(proposalCid) {
  return (await L.query(net.issuer, kit.T.Confirmation)).filter((c) => c.payload.actionProposalCid === proposalCid);
}

const commands = {
  async list() {
    const [requests, proposals, approvals, cleanups, policy] = await Promise.all([
      L.query(net.issuer, kit.T.Intent),
      L.query(net.issuer, kit.T.ApproveAction),
      L.query(net.issuer, kit.T.Approved),
      L.query(net.issuer, kit.T.Cleanup),
      kit.policy(L, net),
    ]);
    const line = (c) => `${c.payload.terms.requestId}: ${Number(c.payload.terms.shareQuantity)} ${c.payload.terms.shareInstrument.id} -> ${Number(c.payload.terms.payoutAmount)} ${c.payload.terms.cashInstrument.id} for ${short(c.payload.terms.investor)}`;
    console.log('Pending requests');
    requests.forEach((c) => console.log('  ' + line(c)));
    console.log('Open proposals');
    for (const p of proposals) {
      const confs = await confirmationsFor(p.contractId);
      console.log(`  ${line(p)}  [${confs.length} of 2 confirmations: ${confs.map((c) => short(c.payload.confirmer)).join(', ')}]`);
    }
    console.log('Approved, awaiting investor');
    approvals.forEach((c) => console.log(`  ${line(c)}  until ${c.payload.expiresAt}`));
    console.log('Reservations awaiting cleanup');
    cleanups.forEach((c) => console.log(`  ${line(c)}  (${c.payload.reason})`));
    console.log(`Policy: ${Number(policy.payload.outstanding)} of ${Number(policy.payload.maxOutstanding)} reserved in ${policy.payload.openReservations} slot(s)`);
  },

  async propose() {
    const who = member(flag('as', 1));
    const request = await findRequest(requestId);
    const { tx, proposalCid } = await kit.propose(L, net, who, request.contractId, request.payload.terms);
    console.log(`${short(who)} proposed approval of ${requestId}\n  proposal ${proposalCid}\n  tx ${tx.updateId}`);
  },

  async confirm() {
    const who = member(flag('as', 2));
    const proposal = await findProposal(requestId);
    const { tx } = await kit.confirm(L, net, who, proposal.contractId);
    const n = (await confirmationsFor(proposal.contractId)).length;
    console.log(`${short(who)} confirmed ${requestId} (${n} of 2)\n  tx ${tx.updateId}`);
  },

  async execute() {
    const who = member(flag('as', 3));
    const proposal = await findProposal(requestId);
    const confs = await confirmationsFor(proposal.contractId);
    const { tx } = await kit.execute(L, net, who, proposal.contractId, confs.map((c) => c.contractId));
    console.log(`${short(who)} executed ${requestId}: request consumed, payout reserved, approval created\n  tx ${tx.updateId}`);
  },

  async approve() {
    const request = await findRequest(requestId);
    const { executed } = await kit.approve(L, net, request.contractId, request.payload.terms);
    console.log(`${requestId} approved 2-of-3 and funded\n  tx ${executed.tx.updateId}`);
  },

  async housekeeping() {
    const who = member(flag('as', 1));
    const slots = new Set((await L.query(net.issuer, kit.T.Slot)).map((c) => c.contractId));
    for (const receipt of await L.query(net.issuer, kit.T.Receipt)) {
      if (!slots.has(receipt.payload.slotCid)) continue;
      const { tx } = await kit.releaseRedeemed(L, net, who, receipt);
      console.log(`released budget of settled ${receipt.payload.terms.requestId}  tx ${tx.updateId}`);
    }
    for (const approval of await L.query(net.issuer, kit.T.Approved)) {
      if (new Date(approval.payload.expiresAt) > new Date()) continue;
      const { tx } = await kit.expire(L, net, who, approval.contractId);
      console.log(`expired ${approval.payload.terms.requestId}  tx ${tx.updateId}`);
    }
    for (const cleanup of await L.query(net.issuer, kit.T.Cleanup)) {
      try {
        const { tx } = await kit.releaseCleanup(L, net, who, cleanup.contractId);
        console.log(`withdrew reservation of ${cleanup.payload.terms.requestId} (${cleanup.payload.reason})  tx ${tx.updateId}`);
      } catch {
        const { tx } = await kit.releaseSlotOnly(L, net, who, cleanup.contractId);
        console.log(`reservation of ${cleanup.payload.terms.requestId} was already gone; released budget  tx ${tx.updateId}`);
      }
    }
    const policy = await kit.policy(L, net);
    console.log(`Policy: ${Number(policy.payload.outstanding)} reserved in ${policy.payload.openReservations} slot(s)`);
  },
};

if (!Object.hasOwn(commands, command || '')) {
  console.error('usage: committee.mjs list | propose|confirm|execute|approve <requestId> [--as N] | housekeeping [--as N]');
  process.exit(2);
}
try {
  await commands[command]();
} catch (e) {
  console.error(`rejected: ${e.message}`);
  process.exitCode = 1;
}

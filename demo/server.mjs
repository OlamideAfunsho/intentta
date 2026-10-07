// Demo server for the single investor page.
//
// It stands in for two things an investor would have in production:
//   1. their own wallet backend, which submits commands as the investor party;
//   2. the Registry's off-ledger API, which hands out choice contexts and
//      disclosed contracts for the share and cash instruments.
//
// It never acts as the issuer or as a committee member. Approval happens
// elsewhere (scripts/committee.mjs, or the DecMan UI), and this server keeps
// working when that tooling is not running.
//
//   node demo/server.mjs            then open http://localhost:8787

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as kit from './lib/kit.mjs';
import { Ledger } from './lib/ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const L = new Ledger({ userId: 'intentta-investor-page' });
const net = kit.loadNet();

// The page can switch between the two demo investors to show that each one
// sees only their own redemptions. A real deployment has one investor per
// authenticated session.
const investors = { investor: net.investor, investor2: net.investor2 };
const partyOf = (who) => {
  if (!Object.hasOwn(investors, who)) throw Object.assign(new Error('unknown investor'), { status: 400 });
  return investors[who];
};

const short = (party) => party.split('::')[0];

async function state(who) {
  const investor = partyOf(who);
  const [shares, cash, intents, approved, receipts] = await Promise.all([
    kit.balances(L, investor, net.share),
    kit.balances(L, investor, net.cash),
    L.query(investor, kit.T.Intent),
    L.query(investor, kit.T.Approved),
    L.query(investor, kit.T.Receipt),
  ]);
  const mine = (c) => c.payload.terms.investor === investor;
  const row = (c, status, extra = {}) => ({
    contractId: c.contractId,
    requestId: c.payload.terms.requestId,
    shares: Number(c.payload.terms.shareQuantity),
    payout: Number(c.payload.terms.payoutAmount),
    recipient: short(c.payload.terms.payoutRecipient),
    status,
    ...extra,
  });
  return {
    investor: { key: who, party: investor, name: short(investor) },
    issuer: short(net.issuer),
    instruments: { share: net.share.instrumentId.id, cash: net.cash.instrumentId.id },
    balances: { shares, cash },
    requests: intents.filter(mine).map((c) => row(c, 'pending', { expiresAt: c.payload.terms.expiresAt })),
    approvals: approved.filter(mine).map((c) => row(c, 'approved', {
      expiresAt: c.payload.expiresAt,
      approvedAt: c.payload.approvedAt,
      expired: new Date(c.payload.expiresAt) <= new Date(),
    })),
    receipts: receipts.filter(mine).map((c) => row(c, 'settled', {
      burned: Number(c.payload.burnedQuantity),
      paid: Number(c.payload.paidAmount),
      redeemedAt: c.payload.redeemedAt,
    })).sort((a, b) => b.redeemedAt.localeCompare(a.redeemedAt)),
  };
}

const actions = {
  async request(who, body) {
    const investor = partyOf(who);
    const shares = Number(body.shares);
    const payout = Number(body.payout);
    const hours = Number(body.validHours || 24);
    if (!(shares > 0) || !(payout > 0) || !(hours > 0)) throw Object.assign(new Error('shares, payout and validity must be positive'), { status: 400 });
    const requestId = String(body.requestId || `RED-${Date.now().toString(36).toUpperCase()}`).slice(0, 40);
    const t = kit.terms(net, {
      investor, requestId, shares, payout,
      expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
    });
    const { tx, intentCid } = await kit.request(L, t);
    return { updateId: tx.updateId, contractId: intentCid, requestId };
  },
  async cancelRequest(who, body) {
    const { tx } = await kit.cancelRequest(L, partyOf(who), body.contractId);
    return { updateId: tx.updateId };
  },
  async redeem(who, body) {
    const investor = partyOf(who);
    const approval = (await kit.approvals(L, investor)).find((a) => a.contractId === body.contractId);
    if (!approval) throw Object.assign(new Error('approval not found for this investor'), { status: 404 });
    const { tx, receiptCid } = await kit.redeem(L, net, investor, approval);
    return {
      updateId: tx.updateId,
      receiptCid,
      steps: tx.events.filter((e) => e.kind === 'exercised').map((e) => e.choice),
    };
  },
  async cancelApproval(who, body) {
    const { tx } = await kit.cancelApproval(L, partyOf(who), body.contractId);
    return { updateId: tx.updateId };
  },
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(join(here, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, await state(url.searchParams.get('as') || 'investor'));
    }
    const match = url.pathname.match(/^\/api\/(\w+)$/);
    if (req.method === 'POST' && match && Object.hasOwn(actions, match[1])) {
      const body = await readJson(req);
      return send(res, 200, await actions[match[1]](body.as || 'investor', body));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    // Ledger rejections are shown to the investor as they are: a failed
    // settlement is an expected outcome, not a server fault.
    send(res, e.status && e.status < 500 ? e.status : 409, { error: e.message, code: e.code });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Investor page: http://localhost:${port}  (ledger ${L.baseUrl})`);
});

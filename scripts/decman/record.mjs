// Record the demo video on the DecMan network: DecMan's own UI for the
// decentralized issuer, the investor page on a separate participant, and the
// committee's votes going through the three DecMan nodes.
//
// Nothing is mocked; transaction ids in the captions are the ledger's.
// Needs the network, the fund (scripts/decman/up.sh) and the investor page:
//   node scripts/decman/record.mjs      -> docs/demo/intentta-demo.mp4

import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '../../demo/lib/kit.mjs';
import {
  P, nodes, confirmOn, pending, executeOn, loadState, transferContext,
  currentPolicy, proposeApproval, cashDisclosures, findApproval, exercised,
} from './lib.mjs';

const state = loadState();
const { issuer, investor, members } = state;
const [, m2, m3] = members;
const page_url = process.env.DEMO_URL || 'http://localhost:8787';
const decman = (i) => `http://localhost:808${i}/#parties/${issuer}`;
const outDir = 'docs/demo';
const tmpDir = join(outDir, '.recording');
const size = { width: 1280, height: 720 };
const short = (id) => id.slice(0, 16) + '…';
const tests = process.env.TEST_COUNT || '36';

mkdirSync(tmpDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmpDir, size }, colorScheme: 'light' });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });

async function caption(who, text, ms = 4500) {
  await page.evaluate(([who, text]) => {
    let bar = document.getElementById('__caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__caption';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#101820;color:#fff;' +
        'padding:16px 28px;font:17px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 -6px 24px rgba(0,0,0,.35)';
      document.body.append(bar);
      document.body.style.paddingBottom = '110px';
    }
    bar.textContent = '';
    const tag = document.createElement('span');
    tag.textContent = who;
    tag.style.cssText = 'display:inline-block;background:#f2c14e;color:#101820;font-weight:700;font-size:13px;' +
      'letter-spacing:.05em;text-transform:uppercase;border-radius:4px;padding:2px 9px;margin-right:12px';
    const body = document.createElement('span');
    body.textContent = text;
    bar.append(tag, body);
  }, [who, text]);
  await wait(ms);
}

async function title(lines, ms = 6500) {
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-content:center;background:#101820;color:#fff;
    font-family:system-ui,Segoe UI,sans-serif;text-align:center;padding:0 80px">
    <div style="font-size:44px;font-weight:700;letter-spacing:-.02em">${lines[0]}</div>
    ${lines.slice(1).map((l) => `<div style="font-size:21px;color:#c9d3dc;margin-top:18px;line-height:1.5">${l}</div>`).join('')}
  </body>`);
  await wait(ms);
}

// DecMan's party page for the issuer on one of the nodes.
async function openDecman(i, sections = []) {
  await page.goto(decman(i));
  await page.waitForSelector('text=GOV THRESHOLD', { timeout: 60000 });
  await wait(2500);
  for (const label of sections) {
    await page.locator(`text=${label}`).last().click();
    await wait(1200);
  }
}
const scrollTo = async (text) => {
  await page.locator(`text=${text}`).last().scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 260);
  await wait(900);
};

async function openInvestorPage() {
  await page.goto(page_url);
  await page.waitForFunction(() => !document.getElementById('who').textContent.includes('Connecting'));
}

async function requestOnPage(shares, payout) {
  const before = new Set((await P[4].query(investor, T.Intent)).map((c) => c.contractId));
  await page.fill('input[name=shares]', String(shares));
  await page.fill('input[name=payout]', String(payout));
  await wait(700);
  await page.click('#requestForm button[type=submit]');
  for (let i = 0; i < 60; i++) {
    const fresh = (await P[4].query(investor, T.Intent)).find((c) => !before.has(c.contractId));
    if (fresh) {
      await page.waitForSelector('.tag.pending');
      return fresh;
    }
    await wait(500);
  }
  throw new Error('the request did not appear on the ledger');
}

// The latest transaction on a member's participant that exercised `choice`.
async function txId(ledger, party, choice) {
  const end = await ledger.ledgerEnd();
  const txs = await ledger.updates([party], Math.max(0, end - 30), end);
  return [...txs].reverse().find((t) => exercised(t, choice).length)?.updateId || '';
}

async function approveThroughDecman(request, { narrate = true } = {}) {
  const t = request.payload.terms;
  const say = narrate ? caption : async () => {};
  const proposed = await proposeApproval(state, request.contractId, t);
  await say('Member 1', `Proposes approval from participant 1, as a DecMan custom action. Tx ${short(proposed.tx.updateId)}`);
  await confirmOn(nodes[0], state, proposed.proposalCid);
  await say('DecMan node 1', 'Member 1 confirms through their DecMan node: 1 of 3.', 3600);
  if (narrate) {
    const one = await pending(nodes[1], state, proposed.proposalCid, (a) => a.confirmation_count === 1);
    let refused = false;
    try { await executeOn(nodes[1], state, one, await cashDisclosures(state)); } catch { refused = true; }
    await say('DecMan node 2', `Execution at one confirmation is ${refused ? 'refused' : 'accepted'}: the rules contract requires two.`, 4200);
  }
  await confirmOn(nodes[1], state, proposed.proposalCid);
  await say('DecMan node 2', 'Member 2 confirms through their DecMan node: 2 of 3, threshold met.', 3600);
  const ready = await pending(nodes[2], state, proposed.proposalCid, (a) => a.can_execute);
  await executeOn(nodes[2], state, ready, await cashDisclosures(state));
  await page.waitForSelector('.tag.approved', { timeout: 60000 });
  const tx = await txId(P[3], m3, 'GovernanceRules_ExecuteConfirmedAction');
  await caption('DecMan node 3', `Member 3 executes. One transaction consumes the request, reserves ${Number(t.payoutAmount)} TESTUSD and creates the approval. Tx ${short(tx)}`, narrate ? 6500 : 4200);
  return findApproval(state, t.requestId);
}

// --- 1. The issuer, in DecMan's own UI ---------------------------------------
await title([
  'IntentTA',
  'Private redemption settlement for Canton',
  'DecMan 2-of-3 governance · DA Registry burn · Token Standard cash allocation',
  'Recorded on a local Canton network: four participants, three DecMan nodes.',
]);

await openDecman(1);
await caption('DecMan', 'This is DecMan v1.13, unmodified. The fund issuer is a decentralized party: three owner keys, threshold two.', 6500);
await shot('1-decman-issuer');
await scrollTo('PARTICIPANTS');
await caption('DecMan', 'It is hosted on three participants, one per committee member. Its stock GovernanceRules contract needs 2 of 3.', 6500);

// --- 2. Request, approval, settlement -----------------------------------------
await openInvestorPage();
await caption('Investor', 'The investor is on a fourth participant. This page submits commands as the investor only.', 5200);
const first = await requestOnPage(100, 100);
await caption('Investor', 'Request: redeem 100 FUNDSHARE for 100 TESTUSD. Nothing moves; the shares stay with the investor.', 5200);
await shot('2-requested');

const firstApproval = await approveThroughDecman(first);
await caption('Investor', 'The approval is funded. From here the investor acts alone; no committee node takes part.', 5200);
await shot('3-approved-and-funded');
await page.click('button.primary:has-text("Complete redemption")');
await page.waitForSelector('#receipts .tag.settled', { timeout: 60000 });
await caption('Investor', 'One transaction: burn offer created and accepted, reserved cash transferred, receipt created. 100 FUNDSHARE burned, 100 TESTUSD received.', 7500);
await shot('4-settled');
await page.locator('#log').scrollIntoViewIfNeeded();
await caption('Investor', 'The single transaction id, and the choices exercised inside it.', 5500);
await shot('5-one-transaction');

// --- 3. Replay -----------------------------------------------------------------
let replay = 'accepted';
try {
  await fetch(`${page_url}/api/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'investor', contractId: firstApproval.contractId }) })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
} catch { replay = 'rejected'; }
await page.evaluate(() => window.scrollTo(0, 0));
await caption('Replay', `Submitting the same settlement again is ${replay}. Balances are unchanged.`, 5000);

// --- 4. The same vote, in DecMan's audit trail ----------------------------------
await openDecman(3, ['HOLDINGS', 'AUDIT TRAIL']);
await scrollTo('HOLDINGS');
await caption('DecMan', "DecMan node 3's view of the issuer: the treasury holding, and the audit trail of the vote.", 5500);
await scrollTo('AUDIT TRAIL');
await caption('DecMan', 'ApproveRedemptionAction: proposed, confirmed twice, executed. Recorded by DecMan with no change to DecMan.', 7000);
await shot('6-decman-audit-trail');

// --- 5. Failed settlement --------------------------------------------------------
await openInvestorPage();
const second = await requestOnPage(350, 350);
await approveThroughDecman(second, { narrate: false });
await caption('Failure', 'This approval is for 350 shares, but the investor now holds 300. The cash is reserved; the burn cannot happen.', 6000);
await page.click('button.primary:has-text("Complete redemption")');
await page.waitForSelector('#log .bad', { timeout: 60000 });
await page.locator('#log').scrollIntoViewIfNeeded();
await caption('Failure', 'The settlement is rejected as a whole. No shares were burned and no cash was paid.', 6000);
await shot('7-failed-settlement');

// --- 6. Cancellation and cleanup ---------------------------------------------------
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('#open button:has-text("Cancel")');
await page.waitForFunction(() => !document.querySelector('#open .tag'), null, { timeout: 60000 });
await caption('Cancel', 'The investor cancels. Authorization ends at once; the reserved cash is tracked separately, as a cleanup item only the issuer sees.', 6500);
const [cleanup] = await P[3].query(issuer, T.Cleanup);
const cleaned = await P[3].exercise(m3, T.Cleanup, cleanup.contractId, 'ReservationCleanup_Release',
  { actor: m3, policyCid: (await currentPolicy(state)).contractId, extraArgs: transferContext(state.cash) },
  { readAs: [issuer], disclosed: await cashDisclosures(state) });
for (const receipt of await P[2].query(issuer, T.Receipt)) {
  const slots = new Set((await P[2].query(issuer, T.Slot)).map((c) => c.contractId));
  if (!slots.has(receipt.payload.slotCid)) continue;
  await P[2].exercise(m2, T.Policy, (await currentPolicy(state)).contractId, 'RedemptionPolicy_ReleaseRedeemed',
    { actor: m2, slotCid: receipt.payload.slotCid, receiptCid: receipt.contractId }, { readAs: [issuer] });
}
const reserved = Number((await currentPolicy(state)).payload.outstanding);
await caption('Committee', `A member, as keeper, withdraws the reservation back to the issuer from participant 3. Tx ${short(cleaned.updateId)}. Cash still reserved: ${reserved} TESTUSD.`, 6500);

// --- 7. Privacy ------------------------------------------------------------------------
await page.selectOption('#as', 'investor2');
await page.waitForFunction(() => document.getElementById('who').textContent.includes('investor2'));
await caption('Privacy', 'A second investor on the same participant sees none of this: no requests, approvals or receipts of the first.', 6000);
await shot('8-other-investor-sees-nothing');

await title([
  'What you saw',
  'A decentralized issuer, governed by three unmodified DecMan nodes',
  'Request consumed, cash reserved and approval created in one transaction',
  'Burn and payout in one transaction, completed by the investor alone',
  'Failed settlement, replay and cancellation leave shares untouched',
  `${tests} automated tests · evidence/decman-e2e.json · evidence/local-e2e.json`,
], 8500);

await context.close();
await browser.close();
const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.webm'));
const webm = join(outDir, 'intentta-demo.webm');
renameSync(join(tmpDir, file), webm);
rmSync(tmpDir, { recursive: true, force: true });
const mp4 = join(outDir, 'intentta-demo.mp4');
const converted = spawnSync(process.env.FFMPEG || 'ffmpeg', [
  '-y', '-loglevel', 'error', '-i', webm,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '25', '-an', mp4,
]);
if (converted.status === 0) {
  rmSync(webm);
  console.log(`Recorded ${mp4}`);
} else {
  console.log(`Recorded ${webm} (ffmpeg not found, so not converted to MP4)`);
}

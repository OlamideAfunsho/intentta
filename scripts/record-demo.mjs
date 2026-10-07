// Record the demo video: the real investor page, on a real local ledger,
// with the committee's steps performed between the investor's clicks.
//
// Nothing is mocked. The captions quote the ledger's own transaction ids.
// Requires a freshly bootstrapped local ledger and the demo server running:
//   node demo/server.mjs &
//   node scripts/record-demo.mjs        -> docs/demo/intentta-demo.mp4

import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as kit from '../demo/lib/kit.mjs';
import { Ledger } from '../demo/lib/ledger.mjs';

const L = new Ledger({ userId: 'intentta-demo-recording' });
const net = kit.loadNet();
const [m1, m2, m3] = net.members;
const url = process.env.DEMO_URL || 'http://localhost:8787';
const outDir = 'docs/demo';
const tmpDir = join(outDir, '.recording');
const size = { width: 1280, height: 720 };
const short = (id) => id.slice(0, 16) + '…';

mkdirSync(tmpDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmpDir, size }, colorScheme: 'light' });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
// Stills of the key moments, for the README and for checking the recording.
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });

// A caption bar over the page. `who` says whose action is being shown.
async function caption(who, text, ms = 4200) {
  await page.evaluate(([who, text]) => {
    let bar = document.getElementById('__caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__caption';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#101820;color:#fff;' +
        'padding:16px 28px;font:17px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 -6px 24px rgba(0,0,0,.25)';
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

async function title(lines, ms = 6000) {
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-content:center;background:#101820;color:#fff;
    font-family:system-ui,Segoe UI,sans-serif;text-align:center;padding:0 80px">
    <div style="font-size:44px;font-weight:700;letter-spacing:-.02em">${lines[0]}</div>
    ${lines.slice(1).map((l) => `<div style="font-size:21px;color:#c9d3dc;margin-top:18px;line-height:1.5">${l}</div>`).join('')}
  </body>`);
  await wait(ms);
}

async function openPage() {
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('who').textContent.includes('Connecting'));
}

async function requestOnPage(shares, payout) {
  await page.fill('input[name=shares]', String(shares));
  await page.fill('input[name=payout]', String(payout));
  await wait(700);
  await page.click('#requestForm button[type=submit]');
  await page.waitForSelector('.tag.pending');
  const [request] = (await L.query(net.investor, kit.T.Intent)).slice(-1);
  return request;
}

async function approveOffPage(request, quick = false) {
  const t = request.payload.terms;
  const pause = quick ? 2600 : 4200;
  const proposed = await kit.propose(L, net, m1, request.contractId, t);
  await caption('Committee', `Member 1 proposes approval as a DecMan custom action. Tx ${short(proposed.tx.updateId)}`, pause);
  const c1 = await kit.confirm(L, net, m1, proposed.proposalCid);
  await caption('Committee', `Member 1 confirms: 1 of 3. Tx ${short(c1.tx.updateId)}`, pause - 1000);
  const c2 = await kit.confirm(L, net, m2, proposed.proposalCid);
  await caption('Committee', `Member 2 confirms: 2 of 3, threshold met. Tx ${short(c2.tx.updateId)}`, pause - 1000);
  const executed = await kit.execute(L, net, m3, proposed.proposalCid, [c1.confirmationCid, c2.confirmationCid]);
  await page.waitForSelector('.tag.approved');
  await caption('Committee', `Member 3 executes. In one transaction the request is consumed, ${Number(t.payoutAmount)} TESTUSD is reserved and the approval is created. Tx ${short(executed.tx.updateId)}`, pause + 1500);
  return (await kit.approvals(L, net.investor)).find((a) => a.payload.terms.requestId === t.requestId);
}

// --- 1. The completion standard --------------------------------------------
await title([
  'IntentTA',
  'Private redemption settlement for Canton',
  'DecMan 2-of-3 governance · DA Registry burn · Token Standard cash allocation',
  'Recorded against a local Canton ledger. Every transaction id shown is real.',
]);

await openPage();
await caption('Investor', 'The investor holds FUNDSHARE and no cash. This page submits commands as the investor only.', 5000);
const first = await requestOnPage(100, 100);
await caption('Investor', 'Request: redeem 100 FUNDSHARE for 100 TESTUSD. Nothing moves; the shares stay with the investor.', 5000);
await shot('1-requested');

const firstApproval = await approveOffPage(first);
await caption('Investor', 'The approval is funded. The committee tooling has exited; from here the investor acts alone.', 5000);
await shot('2-approved-and-funded');
await page.click('button.primary:has-text("Complete redemption")');
await page.waitForSelector('#receipts .tag.settled');
await caption('Investor', 'One transaction: burn offer created and accepted, reserved cash transferred, receipt created. 100 FUNDSHARE burned, 100 TESTUSD received.', 7500);
await shot('3-settled');
await page.locator('#log').scrollIntoViewIfNeeded();
await caption('Investor', 'The ledger activity shows the single transaction id and the choices exercised inside it.', 5500);
await shot('4-one-transaction');

// --- 2. Replay ---------------------------------------------------------------
let replay = 'accepted';
try { await kit.redeem(L, net, net.investor, firstApproval); } catch (e) { replay = e.code || 'rejected'; }
await page.evaluate(() => window.scrollTo(0, 0));
await caption('Replay', `Submitting the same settlement again is rejected by the ledger (${replay}). Balances are unchanged.`, 5500);

// --- 3. Failed settlement ----------------------------------------------------
const second = await requestOnPage(50, 50);
const secondApproval = await approveOffPage(second, true);
const disclosed = await kit.registryDisclosures(L, net.cash);
const withdrawn = await L.exercise(net.issuer, kit.T.Allocation, secondApproval.payload.allocationCid, 'Allocation_Withdraw',
  { extraArgs: kit.transferArgs(net, net.cash) }, { disclosed });
await caption('Failure', `A reservation is not a payment guarantee: the issuer withdraws the reserved cash. Tx ${short(withdrawn.updateId)}`, 5500);
await page.click('button.primary:has-text("Complete redemption")');
await page.waitForSelector('#log .bad');
await page.locator('#log').scrollIntoViewIfNeeded();
await caption('Failure', 'The settlement is rejected as a whole. The payout was unavailable, so no shares were burned.', 6000);
await shot('5-failed-settlement');
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('#open button:has-text("Cancel")');
await page.waitForFunction(() => !document.querySelector('#open .tag'));
await caption('Investor', 'The investor cancels the unusable approval. Holdings are exactly as before.', 4500);

// --- 4. Cancellation and cleanup ---------------------------------------------
const third = await requestOnPage(50, 50);
await approveOffPage(third, true);
await page.click('#open button:has-text("Cancel")');
await page.waitForFunction(() => !document.querySelector('#open .tag'));
await caption('Cancel', 'Cancelling ends the authorization at once. The reserved cash is tracked separately, as a cleanup item only the issuer sees.', 6000);
for (const cleanup of await L.query(net.issuer, kit.T.Cleanup)) {
  try { await kit.releaseCleanup(L, net, m1, cleanup.contractId); } catch { await kit.releaseSlotOnly(L, net, m1, cleanup.contractId); }
}
for (const receipt of await L.query(net.issuer, kit.T.Receipt)) await kit.releaseRedeemed(L, net, m2, receipt);
const policy = await kit.policy(L, net);
await caption('Committee', `Keepers withdraw the cancelled reservation back to the issuer and release the settled one against its receipt. Cash still reserved: ${Number(policy.payload.outstanding)} TESTUSD.`, 6000);

// --- 5. Privacy ---------------------------------------------------------------
await page.selectOption('#as', 'investor2');
await page.waitForFunction(() => document.getElementById('who').textContent.includes('Investor2'));
await caption('Privacy', 'A second investor on the same ledger sees none of this: no requests, approvals or receipts of the first.', 6000);
await shot('6-other-investor-sees-nothing');
await page.selectOption('#as', 'investor');
await wait(1500);

await title([
  'What you saw',
  'Approval through real DecMan governance-core rules, 2 of 3',
  'Request consumed, cash reserved and approval created in one transaction',
  'Burn and payout in one transaction, completed by the investor alone',
  'Failed settlement, replay and cancellation leave shares untouched',
  '36 automated tests · 7 ledger scenarios · evidence/local-e2e.json',
], 8000);

await context.close();
await browser.close();
const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.webm'));
const webm = join(outDir, 'intentta-demo.webm');
renameSync(join(tmpDir, file), webm);
rmSync(tmpDir, { recursive: true, force: true });

// The browser records WebM. Convert to MP4 when ffmpeg is available (on PATH,
// or named by the FFMPEG environment variable); otherwise keep the WebM.
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

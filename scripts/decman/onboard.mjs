// Create the issuer as a DecMan decentralized party across the three nodes:
// node 1 coordinates, nodes 2 and 3 accept the invitation.
import { nodes, dm } from './peers.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = process.argv[2] || 'fund-issuer';
const [n1, n2, n3] = nodes;
const pid = async (n) => (await dm(n, 'GET', '/node-config')).node.participant_id;

await dm(n1, 'POST', '/onboarding', { party_id_prefix: prefix, peer_ids: [await pid(n2), await pid(n3)] });
console.log(`decman1 started onboarding of "${prefix}"`);
for (const n of [n2, n3]) {
  let inv;
  for (let i = 0; i < 60 && !inv; i++) {
    const r = await dm(n, 'GET', '/invitations');
    inv = (r.invitations || [])[0];
    if (!inv) await sleep(1000);
  }
  if (!inv) throw new Error(`no invitation on decman${n.i}`);
  await dm(n, 'POST', '/invitations/accept', { id: inv.id });
  console.log(`decman${n.i} accepted invitation ${inv.id}`);
}
for (let i = 0; i < 240; i++) {
  const s = await dm(n1, 'GET', '/onboarding/status');
  if (/completed/i.test(s.status || '')) { console.log('onboarding completed'); break; }
  if (/failed/i.test(s.status || '')) throw new Error(`onboarding failed: ${s.error}`);
  if (i % 10 === 0) console.log(`  status: ${s.status} ${s.current_step || ''}`);
  await sleep(1000);
}
const parties = await dm(n1, 'GET', '/decentralized-parties');
console.log(JSON.stringify(parties, null, 1).slice(0, 1500));

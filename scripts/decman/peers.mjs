// Tell each DecMan node about the other two, as DecMan's own integration
// test does, then restart them so the peer keys are loaded.
import { execFileSync } from 'node:child_process';

export const nodes = [1, 2, 3].map((i) => ({ i, url: `http://localhost:808${i}`, host: `decman${i}`, noise: 9000 + i }));
export async function dm(node, method, path, body) {
  const res = await fetch(node.url + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`decman${node.i} ${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return json;
}

if (process.argv[1]?.endsWith('peers.mjs')) {
  const peers = [];
  for (const n of nodes) {
    const key = (await dm(n, 'GET', '/keys/status')).public_key;
    const pid = (await dm(n, 'GET', '/node-config')).node.participant_id;
    peers.push({ participant_id: pid, name: `Member ${n.i}`, address: n.host, port: n.noise, public_key: key, party: null });
    console.log(`decman${n.i}: ${pid}`);
  }
  for (const n of nodes) await dm(n, 'POST', '/network-config', peers);
  execFileSync('docker', ['restart', 'decman1', 'decman2', 'decman3'], { stdio: 'ignore' });
  console.log('peers configured, nodes restarted');
}

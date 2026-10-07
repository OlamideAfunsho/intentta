// Create the ledger user that DecMan's insecure-mode token names
// ("ledger-api-user") on each participant, with participant-admin rights and
// read access to every party. Authenticates as Canton's built-in
// participant_admin user with a token for the local unsafe auth service.
import { createHmac } from 'node:crypto';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function localToken(sub, lifetimeSeconds = 240) {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'https://canton.network.global', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + lifetimeSeconds })}`;
  // "unsafe" is the shared secret of the throwaway local network, not a credential.
  return `${body}.${createHmac('sha256', 'unsafe').update(body).digest('base64url')}`;
}

export const participants = [
  { name: 'participant1', json: 'http://localhost:5003' },
  { name: 'participant2', json: 'http://localhost:5013' },
  { name: 'participant3', json: 'http://localhost:5023' },
  { name: 'participant4', json: 'http://localhost:5033' },
];

export async function api(p, method, path, body, sub = 'participant_admin') {
  const res = await fetch(p.json + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localToken(sub)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${p.name} ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return json;
}

if (process.argv[1]?.endsWith('ledger-users.mjs')) {
  for (const p of participants) {
    const rights = [
      { kind: { ParticipantAdmin: { value: {} } } },
      { kind: { CanReadAsAnyParty: { value: {} } } },
    ];
    try {
      await api(p, 'POST', '/v2/users', { user: { id: 'ledger-api-user', primaryParty: '', isDeactivated: false, identityProviderId: '', metadata: { resourceVersion: '', annotations: {} } }, rights });
      console.log(`${p.name}: created ledger-api-user`);
    } catch (e) {
      console.log(`${p.name}: ${e.message}`);
    }
  }
}

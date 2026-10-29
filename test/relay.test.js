import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phone ⇄ relay ⇄ Mac, all real: the Node relay, Lookout's server, and Lookout's outbound relay client.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-relay-'));
process.env.LOOKOUT_HOME = path.join(home, '.lookout');
process.env.LOOKOUT_USER_HOME = home;
process.env.LOOKOUT_PORT = '4495';
const { createServer } = await import('../server/index.js');
const relayClient = await import('../server/relay-client.js');
const { createRelay } = await import('../relay/server.js');
const e2e = await import('../public/e2e.js');

const lookout = createServer();
await new Promise(r => lookout.listen(4495, '127.0.0.1', r));
// RELAY_URL runs the same checks against another relay, such as the Cloudflare Worker under `wrangler dev`.
const external = process.env.RELAY_URL;
const relayServer = external ? null : createRelay();
if (relayServer) await new Promise(r => relayServer.listen(8795, '127.0.0.1', r));
test.after(() => { relayClient.stop(); lookout.close(); lookout.closeAllConnections(); relayServer?.close(); relayServer?.closeAllConnections(); });

const PASSWORD = 'correct horse battery';
const R = external || 'http://127.0.0.1:8795';
const jar = {};
const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const keep = res => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; } };
const phone = async (p, init = {}) => { const res = await fetch(R + p, { redirect:'manual', ...init, headers:{ cookie:cookies(), ...(init.headers || {}) } }); keep(res); return res; };

// What the relay sees: every frame in both directions, decoded.
const seen = [];
let key;
let macId;
async function sealed(method, p, body, { k = key, nonce = e2e.b64(crypto.getRandomValues(new Uint8Array(18))), ts = Date.now() } = {}) {
  const box = await e2e.seal(k, { method, path:p, body:body ?? null, ts }, e2e.requestAad(nonce));
  const res = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1' }, body:JSON.stringify({ nonce, box }) });
  if (res.status !== 200) return { outer:res.status, text:await res.text(), nonce, box };
  const reply = await e2e.open(k, (await res.json()).box, e2e.responseAad(nonce));
  return { outer:200, status:reply.status, json:JSON.parse(Buffer.from(reply.body, 'base64').toString() || 'null'), nonce, box };
}

test('the Mac connects out to the relay', async () => {
  const setup = await fetch('http://127.0.0.1:4495/api/auth/setup', { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1', host:'localhost:4495' }, body:JSON.stringify({ password:PASSWORD }) });
  assert.equal(setup.status, 200);
  relayClient.boot(4495);
  relayClient.configure({ url:R, enabled:true });
  for (let i = 0; i < 50 && relayClient.status().status !== 'on'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(relayClient.status().status, 'on');
  macId = relayClient.status().macId;
  assert.equal(relayClient.status().link, `${R}/m/${macId}`);
  if (!relayServer) return;
  const room = relayServer.rooms.get(macId);
  const send = room.socket.send.bind(room.socket);
  room.socket.send = t => { seen.push(t); send(t); };
  const receive = room.receive.bind(room);
  room.receive = m => { seen.push(JSON.stringify(m), m.data ? Buffer.from(m.data, 'base64').toString() : ''); receive(m); };
});

test('the phone opens the app through the relay; private API calls must be sealed', async () => {
  const pair = await phone(`/m/${macId}`);
  assert.equal(pair.status, 302);
  assert.equal(jar.lookout_mac, macId);
  assert.match(await (await phone('/')).text(), /<title>Lookout<\/title>/);
  const manifest = await (await phone('/manifest.webmanifest')).json();
  assert.equal(manifest.start_url, `/m/${macId}/?source=homescreen`);
  const info = await (await phone('/relay-info')).json();
  assert.equal(info.relay, true);
  assert.equal((await phone('/api/home')).status, 403);
  assert.equal((await phone('/api/auth/state')).status, 403);
  key = await e2e.importKey(await e2e.deriveKeyBytes(PASSWORD, info.salt, info.iterations));
});

test('wrong password is rejected; sign-in and approval work end to end', async () => {
  const info = await (await phone('/relay-info')).json();
  const wrong = await e2e.importKey(await e2e.deriveKeyBytes('not my password', info.salt, info.iterations));
  assert.equal((await sealed('GET', '/api/auth/state', null, { k:wrong })).outer, 401);
  assert.equal((await sealed('GET', '/api/auth/state')).json.authed, false);
  const login = await sealed('POST', '/api/auth/login', { password:PASSWORD });
  assert.equal(login.status, 202);
  assert.ok(jar.lookout, 'device cookie set through the relay');
  assert.equal((await sealed('GET', '/api/home')).status, 423);
  // Approve on the Mac, then the phone is in.
  const macCookie = (await fetch('http://127.0.0.1:4495/api/auth/login', { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1' }, body:JSON.stringify({ password:PASSWORD }) })).headers.getSetCookie()[0].split(';')[0];
  const devices = await (await fetch('http://127.0.0.1:4495/api/settings', { headers:{ cookie:macCookie } })).json();
  const pending = devices.devices.find(d => !d.approved);
  assert.equal(pending.remote, true);
  await fetch('http://127.0.0.1:4495/api/devices/approve', { method:'POST', headers:{ cookie:macCookie, 'content-type':'application/json', 'x-lookout':'1' }, body:JSON.stringify({ id:pending.id }) });
  const homeData = await sealed('GET', '/api/home');
  assert.equal(homeData.status, 200);
  assert.ok(Array.isArray(homeData.json.sessions));
});

test('large replies stream through in chunks', async () => {
  const procs = await sealed('GET', '/api/processes');
  assert.equal(procs.status, 200);
  assert.ok(procs.json.length > 50);
});

test('replays, stale envelopes and Mac-only actions are refused', async () => {
  const first = await sealed('GET', '/api/badges');
  const again = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1' }, body:JSON.stringify({ nonce:first.nonce, box:first.box }) });
  assert.equal(again.status, 409);
  assert.equal((await sealed('GET', '/api/badges', null, { ts:Date.now() - 10 * 60000 })).outer, 409);
  assert.equal((await sealed('POST', '/api/tunnel', { on:true })).status, 403);
  assert.equal((await sealed('POST', '/api/relay', { enabled:false })).status, 403);
});

test('the relay never sees the password or any private data', { skip:Boolean(external) && 'needs the in-process relay to watch its traffic' }, () => {
  const all = seen.join('\n');
  assert.ok(seen.length > 10);
  assert.ok(!all.includes(PASSWORD), 'password visible to relay');
  assert.ok(!all.includes('"sessions"'), 'session data visible to relay');
  assert.ok(!all.includes('"processes"') && !all.includes('"pid"'), 'process list visible to relay');
});

test('a stranger cannot take over this Mac id on the relay', async () => {
  const closed = await new Promise(resolve => {
    const ws = new WebSocket(`${R.replace('http', 'ws')}/connect?mac=${macId}`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t:'hello', mac:macId, secret:'guess' })));
    ws.addEventListener('close', e => resolve(e.code));
  });
  assert.equal(closed, 4003);
  assert.equal(relayClient.status().status, 'on');
});

test('when the Mac goes away the phone gets a clear offline answer', async () => {
  relayClient.stop();
  await new Promise(r => setTimeout(r, 200));
  const res = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1' }, body:'{}' });
  assert.equal(res.status, 503);
  const page = await phone('/', { headers:{ accept:'text/html' } });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Can't reach your Mac/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phone ⇄ relay ⇄ Mac, all real: the Node relay, AgentsEye's server, and AgentsEye's outbound relay client.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentseye-relay-'));
process.env.AGENTSEYE_HOME = path.join(home, '.agentseye');
process.env.AGENTSEYE_USER_HOME = home;
process.env.AGENTSEYE_PORT = '4495';
const { createServer } = await import('../server/index.js');
const relayClient = await import('../server/relay-client.js');
const { createRelay } = await import('../relay/server.js');
const e2e = await import('../public/e2e.js');

const agentseye = createServer();
await new Promise(r => agentseye.listen(4495, '127.0.0.1', r));
// RELAY_URL runs the same checks against another relay, such as the Cloudflare Worker under `wrangler dev`.
const external = process.env.RELAY_URL;
const relayServer = external ? null : createRelay();
if (relayServer) await new Promise(r => relayServer.listen(8795, '127.0.0.1', r));
test.after(() => { relayClient.stop(); agentseye.close(); agentseye.closeAllConnections(); relayServer?.close(); relayServer?.closeAllConnections(); });

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
  const res = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye':'1' }, body:JSON.stringify({ nonce, box }) });
  if (res.status !== 200) return { outer:res.status, text:await res.text(), nonce, box };
  const reply = await e2e.open(k, (await res.json()).box, e2e.responseAad(nonce));
  return { outer:200, status:reply.status, json:JSON.parse(Buffer.from(reply.body, 'base64').toString() || 'null'), nonce, box };
}

test('the Mac connects out to the relay', async () => {
  const setup = await fetch('http://127.0.0.1:4495/api/auth/setup', { method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye':'1', host:'localhost:4495' }, body:JSON.stringify({ password:PASSWORD }) });
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
  assert.equal(pair.headers.get('location'), `/?mac=${macId}`);
  assert.equal(jar.agentseye_mac, macId);
  // The address bar link, pasted into a different browser (no cookie), still finds this Mac.
  const other = await fetch(`${R}/?mac=${macId}`, { redirect:'manual' });
  assert.equal(other.headers.get('location'), `/m/${macId}`);
  const back = await fetch(R + other.headers.get('location'), { redirect:'manual' });
  assert.equal(back.headers.get('location'), `/?mac=${macId}`);
  assert.match(back.headers.get('set-cookie'), new RegExp(`agentseye_mac=${macId}`));
  assert.match(await (await phone('/')).text(), /<title>AgentsEye<\/title>/);
  const manifest = await (await phone('/manifest.webmanifest')).json();
  assert.equal(manifest.start_url, `/m/${macId}/?source=homescreen`);
  const info = await (await phone('/relay-info')).json();
  assert.equal(info.relay, true);
  assert.equal(info.macId, macId);
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
  assert.ok(jar.agentseye, 'device cookie set through the relay');
  assert.equal((await sealed('GET', '/api/home')).status, 423);
  // Approve on the Mac, then the phone is in.
  const macCookie = (await fetch('http://127.0.0.1:4495/api/auth/login', { method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye':'1' }, body:JSON.stringify({ password:PASSWORD }) })).headers.getSetCookie()[0].split(';')[0];
  const devices = await (await fetch('http://127.0.0.1:4495/api/settings', { headers:{ cookie:macCookie } })).json();
  const pending = devices.devices.find(d => !d.approved);
  assert.equal(pending.remote, true);
  await fetch('http://127.0.0.1:4495/api/devices/approve', { method:'POST', headers:{ cookie:macCookie, 'content-type':'application/json', 'x-agentseye':'1' }, body:JSON.stringify({ id:pending.id }) });
  const homeData = await sealed('GET', '/api/home');
  assert.equal(homeData.status, 200);
  assert.ok(Array.isArray(homeData.json.agents));
});

test('a shared link reads one chat with its own key, and nothing else', async () => {
  const dir = path.join(home, '.claude', 'projects', '-shared');
  fs.mkdirSync(dir, { recursive:true });
  const id = '99999999-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type:'ai-title', aiTitle:'Shared task' },
    { type:'user', cwd:home, message:{ content:'fix the login' } },
    { type:'assistant', message:{ content:[{ type:'text', text:'Fixed it.' }] } },
  ].map(JSON.stringify).join('\n'));
  const made = await sealed('POST', '/api/share', { kind:'local', harness:'claude', id, hours:1 });
  assert.equal(made.status, 200);
  const url = new URL(made.json.link);
  const shareId = url.searchParams.get('share');
  const raw = Uint8Array.from(Buffer.from(new URLSearchParams(url.hash.slice(1)).get('k'), 'base64url'));
  const k = await e2e.importKey(raw);
  // Whoever opens it: no password, no cookie, only the link.
  const open = async (shareKey = k) => {
    const nonce = e2e.b64(crypto.getRandomValues(new Uint8Array(18)));
    const box = await e2e.seal(shareKey, { method:'GET', path:'/api/home', ts:Date.now() }, e2e.requestAad(nonce));
    const res = await fetch(`${R}/api/e2e`, { method:'POST', headers:{ cookie:`agentseye_mac=${macId}`, 'content-type':'application/json', 'x-agentseye':'1' }, body:JSON.stringify({ nonce, box, share:shareId }) });
    if (res.status !== 200) return { outer:res.status };
    const reply = await e2e.open(shareKey, (await res.json()).box, e2e.responseAad(nonce));
    return JSON.parse(Buffer.from(reply.body, 'base64').toString());
  };
  const view = await open();
  // Asking for /api/home still only returns the shared chat.
  assert.equal(view.title, 'Shared task');
  assert.deepEqual(view.messages.map(m => m.text), ['fix the login', 'Fixed it.']);
  assert.equal((await open(key)).outer, 401);
  await sealed('POST', '/api/share/revoke', { id:shareId });
  assert.equal((await open()).outer, 410);
});

test('large replies stream through in chunks', async () => {
  const procs = await sealed('GET', '/api/processes');
  assert.equal(procs.status, 200);
  assert.ok(procs.json.length > 50);
});

test('replays, stale envelopes and Mac-only actions are refused', async () => {
  const first = await sealed('GET', '/api/badges');
  const again = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye':'1' }, body:JSON.stringify({ nonce:first.nonce, box:first.box }) });
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
  const res = await phone('/api/e2e', { method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye':'1' }, body:'{}' });
  assert.equal(res.status, 503);
  const page = await phone('/', { headers:{ accept:'text/html' } });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Your Mac is offline/);
});

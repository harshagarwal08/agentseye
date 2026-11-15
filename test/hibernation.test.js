import test from 'node:test';
import assert from 'node:assert/strict';
import { HibernatingMacRoom } from '../relay/mac-room.js';

globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };
const MAC = 'abcdefghijklmnop';
function fixture() {
  const sockets = [], stored = new Map();
  const state = {
    getWebSockets:() => sockets,
    setWebSocketAutoResponse(pair) { this.auto = pair; },
    blockConcurrencyWhile:fn => fn(),
    storage:{
      get:async key => stored.get(key), put:async (key, value) => stored.set(key, value),
      setAlarm:async at => { state.deadline = at; }, deleteAlarm:async () => { state.deadline = null; },
    },
  };
  const socket = (attachment = { macId:MAC, authenticated:false, deadline:Date.now() + 10000 }) => {
    const ws = { readyState:1, sent:[], attachment,
      deserializeAttachment() { return this.attachment; }, serializeAttachment(value) { this.attachment = structuredClone(value); },
      send(value) { this.sent.push(JSON.parse(value)); }, close(code, reason) { this.readyState = 3; this.closed = { code, reason }; },
    };
    sockets.push(ws); return ws;
  };
  const create = () => new HibernatingMacRoom(state, {}, 'test');
  const hello = (room, ws, secret = 'a-long-secret') => room.webSocketMessage(ws, JSON.stringify({ t:'hello', mac:MAC, secret }));
  return { state, stored, socket, create, hello };
}

test('idle sockets use hibernation and automatic heartbeat replies without storing the secret', async () => {
  const f = fixture(), ws = f.socket(), room = f.create();
  assert.equal(f.state.auto.request, '{"t":"ping"}');
  assert.equal(f.state.auto.response, '{"t":"pong"}');
  await f.hello(room, ws);
  assert.deepEqual(ws.sent, [{ t:'welcome' }]);
  assert.deepEqual(ws.attachment, { macId:MAC, authenticated:true });
  assert.equal(f.state.deadline, null, 'no recurring alarm keeps the object awake');
  assert.match(f.stored.get('secret'), /^[a-f0-9]{64}$/);
});

test('authenticated socket resumes after hibernation and forwards a complete encrypted response', async () => {
  const f = fixture(), ws = f.socket();
  await f.hello(f.create(), ws);
  const room = f.create();
  assert.equal(room.room.socket, ws);
  const pending = room.room.forward(new Request('https://relay.example/api/e2e', { method:'POST', body:'encrypted' }), { macId:MAC });
  await new Promise(resolve => setImmediate(resolve));
  const req = ws.sent.at(-1);
  assert.equal(req.t, 'req');
  assert.match(req.id, /^[a-f0-9-]{36}$/);
  await room.webSocketMessage(ws, JSON.stringify({ t:'head', id:req.id, status:200, headers:[['content-type', 'application/json']] }));
  await room.webSocketMessage(ws, JSON.stringify({ t:'body', id:req.id, data:btoa('{"box":"ciphertext"}') }));
  await room.webSocketMessage(ws, JSON.stringify({ t:'end', id:req.id }));
  assert.deepEqual(await (await pending).json(), { box:'ciphertext' });
  assert.equal(room.room.pending.size, 0);
});

test('bad reconnect secrets cannot replace the existing Mac; valid reconnects retire old requests', async () => {
  const f = fixture(), old = f.socket(), room = f.create();
  await f.hello(room, old);
  const stranger = f.socket(); await f.hello(room, stranger, 'wrong');
  assert.equal(stranger.closed.code, 4003);
  assert.equal(room.room.socket, old);
  const pending = room.room.forward(new Request('https://relay.example/relay-info'), { macId:MAC });
  const next = f.socket(); await f.hello(room, next);
  assert.equal(old.closed.code, 4000);
  assert.equal((await pending).status, 503);
  assert.equal(room.room.pending.size, 0);
  await room.webSocketClose(old);
  assert.equal(room.room.socket, next, 'old close events cannot disconnect the replacement');
});

test('handshake expiry closes only unauthenticated sockets and clears its alarm', async () => {
  const f = fixture(), ready = f.socket(), room = f.create(); await f.hello(room, ready);
  const expired = f.socket({ macId:MAC, authenticated:false, deadline:Date.now() - 1 });
  await room.alarm();
  assert.equal(expired.closed.code, 4001);
  assert.equal(ready.readyState, 1);
  assert.equal(f.state.deadline, null);
});

test('a disconnected socket fails pending requests instead of leaving the phone waiting', async () => {
  const f = fixture(), ws = f.socket(), room = f.create(); await f.hello(room, ws);
  const pending = room.room.forward(new Request('https://relay.example/relay-info'), { macId:MAC });
  ws.close(1000, 'done'); await room.webSocketClose(ws);
  assert.equal((await pending).status, 503);
  assert.equal(room.room.pending.size, 0);
  assert.equal(room.room.socket, null);
});

test('a shared relay gives each Mac a daily share; exempt Macs and personal relays are unlimited', async () => {
  const f = fixture();
  const ws = f.socket();
  let room = new HibernatingMacRoom(f.state, { MAC_DAILY_LIMIT:'3' }, 'test');
  await f.hello(room, ws);
  const results = [];
  for (let i = 0; i < 4; i++) { const ok = await room.allow(); results.push(ok); if (ok) await room.charge(); }
  assert.deepEqual(results, [true, true, true, false]);
  const exempt = new HibernatingMacRoom(f.state, { MAC_DAILY_LIMIT:'1', UNLIMITED_MACS:`other, ${MAC}` }, 'test');
  exempt.room.macId = MAC;
  assert.equal(await exempt.allow(), true);
  assert.equal(await exempt.allow(), true);
  const personal = new HibernatingMacRoom(f.state, {}, 'test');
  assert.equal(await personal.allow(), true);
});

test('sleeping between requests never resets the daily share', async () => {
  const f = fixture();
  f.socket({ macId:MAC, authenticated:true });
  let accepted = 0;
  // Wake, send a few requests, sleep (a fresh object), repeat: the count must survive every sleep.
  for (let wake = 0; wake < 30; wake++) {
    const room = new HibernatingMacRoom(f.state, { MAC_DAILY_LIMIT:'25' }, 'test');
    for (let i = 0; i < 3; i++) if (await room.allow()) { await room.charge(); accepted++; }
  }
  assert.ok(accepted <= 25, `accepted ${accepted} against a limit of 25`);
});

test('requests the Mac rejects do not use up its share', async () => {
  const f = fixture();
  const ws = f.socket();
  const room = new HibernatingMacRoom(f.state, { MAC_DAILY_LIMIT:'2' }, 'test');
  await f.hello(room, ws);
  ws.send = value => {
    const m = JSON.parse(value);
    if (m.t !== 'req') return;
    queueMicrotask(() => { room.room.receive({ t:'head', id:m.id, status:401, headers:[['content-type', 'application/json']] }); room.room.receive({ t:'end', id:m.id }); });
  };
  const junk = () => room.fetch(new Request('https://relay.example/api/e2e', { method:'POST', body:'{}', headers:{ 'x-agentseye-mac':MAC } }));
  for (let i = 0; i < 5; i++) assert.equal((await junk()).status, 401);
  assert.equal(await room.allow(), true, 'rejected junk did not count');
});


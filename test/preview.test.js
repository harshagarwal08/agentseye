import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-preview-'));
process.env.LOOKOUT_HOME = path.join(home, '.lookout');
process.env.LOOKOUT_PORT = '4497';
process.env.LOOKOUT_PREVIEW_PORT = '4498';
const preview = await import('../server/preview.js');
const { parseStatus } = await import('../server/tailscale.js');

// A stand-in dev server that echoes the Host it saw and upgrades websockets.
const dev = http.createServer((req, res) => res.end(JSON.stringify({ host:req.headers.host, path:req.url, cookie:req.headers.cookie || '' })));
const devSockets = new Set();
dev.on('upgrade', (req, socket) => { devSockets.add(socket); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); socket.on('data', d => socket.write(d)); });
await new Promise(r => dev.listen(0, '127.0.0.1', r));
const devPort = dev.address().port;
const proxy = preview.createProxy();
await new Promise(r => proxy.listen(4498, '127.0.0.1', r));
test.after(() => { preview.stop(); devSockets.forEach(k => k.destroy()); dev.close(); proxy.close(); proxy.closeAllConnections(); dev.closeAllConnections(); });

const get = (p, cookie = '') => new Promise(resolve => http.get({ host:'127.0.0.1', port:4498, path:p, headers:{ cookie } }, res => {
  let body = '';
  res.on('data', c => { body += c; });
  res.on('end', () => resolve({ status:res.statusCode, body, headers:res.headers }));
}));

test('preview needs a one-time pass, then proxies the whole origin with the dev server as Host', async () => {
  assert.equal((await get('/')).status, 401);
  await assert.rejects(preview.open(1, { local:true }), /dev server port/);
  const { url } = await preview.open(devPort, { local:true });
  const enter = await get(new URL(url).pathname + new URL(url).search);
  assert.equal(enter.status, 302);
  const cookie = enter.headers['set-cookie'][0].split(';')[0];
  // The pass works once.
  assert.equal((await get(new URL(url).pathname + new URL(url).search)).status, 403);
  const page = JSON.parse((await get('/assets/app.js?v=1', `${cookie}; theirs=1`)).body);
  assert.deepEqual(page, { host:`localhost:${devPort}`, path:'/assets/app.js?v=1', cookie:'theirs=1' });
});

test('websockets for hot reload pass through after the cookie check', async () => {
  const { url } = await preview.open(devPort, { local:true });
  const cookie = (await get(new URL(url).pathname + new URL(url).search)).headers['set-cookie'][0].split(';')[0];
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(4498, '127.0.0.1', () => s.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\n\r\n`));
    let data = '';
    s.on('data', d => { data += d; if (data.includes('\r\n\r\n') && !data.includes('ping')) s.write('ping'); if (data.endsWith('ping')) { s.end(); resolve(data); } });
    s.on('error', reject);
  });
  assert.match(reply, /101 Switching Protocols[\s\S]*ping$/);
  const denied = await new Promise(resolve => { const s = net.connect(4498, '127.0.0.1', () => s.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')); s.on('close', () => resolve(true)); });
  assert.ok(denied);
});

test('dev server candidates skip Lookout and system programs', () => {
  const ports = [{ protocol:'TCP', port:5173, command:'node', pid:1 }, { protocol:'TCP', port:4497, command:'node', pid:2 }, { protocol:'TCP', port:5000, command:'ControlCe', pid:3 }, { protocol:'TCP', port:8000, command:'Python', pid:4 }, { protocol:'UDP', port:9000, command:'node', pid:5 }];
  assert.deepEqual(preview.candidates(ports).map(p => p.port), [5173, 8000]);
});

test('tailscale status parsing', () => {
  assert.deepEqual(parseStatus(JSON.stringify({ BackendState:'Running', Self:{ DNSName:'mac.tail1.ts.net.' } })), { state:'running', dns:'mac.tail1.ts.net' });
  assert.equal(parseStatus(JSON.stringify({ BackendState:'NeedsLogin', Self:{} })).state, 'signed-out');
});

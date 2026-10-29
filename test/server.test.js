import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-test-'));
process.env.LOOKOUT_HOME = path.join(home, '.lookout');
process.env.LOOKOUT_USER_HOME = home;
process.env.LOOKOUT_PORT = '4499';
process.env.LOOKOUT_CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json');

const { createServer } = await import('../server/index.js');
const auth = await import('../server/auth.js');
const { installHook, uninstallHook } = await import('../server/hookinstall.js');
const server = createServer();
await new Promise(resolve => server.listen(4499, '127.0.0.1', resolve));
test.after(() => { server.close(); server.closeAllConnections(); });

// Raw http so tests can set Host and Cloudflare headers like a phone coming through the tunnel would.
function call(route, body, { cookie = '', remote = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host:'127.0.0.1', port:4499, path:route, method:data ? 'POST' : 'GET', headers:{
      host:'localhost:4499', cookie, ...(data ? { 'content-type':'application/json', 'x-lookout':'1' } : {}),
      ...(remote ? { 'cf-connecting-ip':'203.0.113.9', 'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' } : {}), ...headers,
    } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status:res.statusCode, body:json, text, cookie:(res.headers['set-cookie']?.[0] || '').split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

let mac = '';
test('password setup happens on the Mac and blocks CSRF', async () => {
  assert.equal((await call('/api/processes')).status, 401);
  assert.equal((await call('/api/auth/setup', { password:'correct horse' }, { headers:{ 'x-lookout':'' } })).status, 403);
  assert.equal((await call('/api/auth/setup', { password:'correct horse' }, { remote:true })).status, 403);
  assert.equal((await call('/api/auth/setup', { password:'short' })).status, 400);
  const setup = await call('/api/auth/setup', { password:'correct horse' });
  assert.equal(setup.status, 200);
  mac = setup.cookie;
  assert.equal((await call('/api/auth/setup', { password:'another one' })).status, 409);
  assert.ok(Array.isArray((await call('/api/processes', undefined, { cookie:mac })).body));
});

test('rejects foreign Host headers', async () => {
  assert.equal((await call('/api/auth/state', undefined, { headers:{ host:'evil.example:4499' } })).status, 421);
});

test('a phone waits for approval on the Mac', async () => {
  const login = await call('/api/auth/login', { password:'correct horse' }, { remote:true });
  assert.equal(login.status, 202);
  const phone = login.cookie;
  assert.equal((await call('/api/processes', undefined, { cookie:phone, remote:true })).status, 423);
  const state = (await call('/api/auth/state', undefined, { cookie:phone, remote:true })).body;
  assert.deepEqual([state.authed, state.approved, state.device.name], [true, false, 'iPhone · Safari']);
  const pending = (await call('/api/badges', undefined, { cookie:mac })).body.devicesWaiting;
  assert.equal(pending, 1);
  const id = auth.listDevices().find(d => !d.approved).id;
  // The phone cannot approve itself, even with another approved phone session.
  assert.equal((await call('/api/devices/approve', { id }, { cookie:phone, remote:true })).status, 423);
  assert.equal((await call('/api/devices/approve', { id }, { cookie:mac })).status, 200);
  assert.equal((await call('/api/processes', undefined, { cookie:phone, remote:true })).status, 200);
  assert.equal((await call('/api/tunnel', { on:false }, { cookie:phone, remote:true })).status, 403);
});

test('a pairing code skips approval once', async () => {
  const { code } = auth.pairingCode();
  const first = await call('/api/auth/login', { password:'correct horse', pair:code }, { remote:true });
  assert.equal(first.status, 200);
  const second = await call('/api/auth/login', { password:'correct horse', pair:code }, { remote:true });
  assert.equal(second.status, 202);
  assert.equal((await call('/api/auth/login', { password:'wrong password' }, { remote:true })).status, 401);
});

test('hook round trip: request waits for a decision from the phone', async () => {
  const hook = spawn(process.execPath, [path.resolve('hooks/permission-hook.mjs')], { env:{ ...process.env } });
  let out = '';
  hook.stdout.on('data', c => { out += c; });
  hook.stdin.end(JSON.stringify({ session_id:'abc', cwd:'/tmp', tool_name:'Bash', tool_input:{ command:'rm -rf build' } }));
  let pending = [];
  for (let i = 0; i < 60 && !pending.length; i++) { await new Promise(r => setTimeout(r, 50)); pending = (await call('/api/approvals', undefined, { cookie:mac })).body.pending; }
  assert.equal(pending[0].input.command, 'rm -rf build');
  assert.equal((await call('/api/badges', undefined, { cookie:mac })).body.needsYou, 1);
  assert.equal((await call('/api/approvals/decide', { id:pending[0].id, decision:'deny', message:'not now' }, { cookie:mac })).status, 200);
  await new Promise(r => hook.on('close', r));
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput:{ hookEventName:'PermissionRequest', decision:{ behavior:'deny', message:'not now' } } });
});

test('hook falls through when holding is off, and only accepts local callers with the token', async () => {
  await call('/api/approvals/settings', { hold:false }, { cookie:mac });
  const hook = spawn(process.execPath, [path.resolve('hooks/permission-hook.mjs')], { env:{ ...process.env } });
  let out = '';
  hook.stdout.on('data', c => { out += c; });
  hook.stdin.end(JSON.stringify({ tool_name:'Write', tool_input:{} }));
  assert.equal(await new Promise(r => hook.on('close', r)), 0);
  assert.equal(out, '');
  assert.equal((await call('/hook/permission', {}, { headers:{ 'x-lookout-token':'nope' } })).status, 403);
  assert.equal((await call('/hook/permission', {}, { remote:true, headers:{ 'x-lookout-token':auth.hookToken() } })).status, 403);
  await call('/api/approvals/settings', { hold:true }, { cookie:mac });
});

test('hook installer keeps other hooks and is idempotent', () => {
  fs.mkdirSync(path.dirname(process.env.LOOKOUT_CLAUDE_SETTINGS), { recursive:true });
  fs.writeFileSync(process.env.LOOKOUT_CLAUDE_SETTINGS, JSON.stringify({ model:'opus', hooks:{ PermissionRequest:[{ matcher:'Bash', hooks:[{ type:'command', command:'other' }] }] } }));
  installHook();
  installHook();
  let s = JSON.parse(fs.readFileSync(process.env.LOOKOUT_CLAUDE_SETTINGS, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.PermissionRequest.length, 2);
  uninstallHook();
  s = JSON.parse(fs.readFileSync(process.env.LOOKOUT_CLAUDE_SETTINGS, 'utf8'));
  assert.deepEqual(s.hooks.PermissionRequest, [{ matcher:'Bash', hooks:[{ type:'command', command:'other' }] }]);
});

test('sessions: home list, chat with file buttons, files tab, safe downloads', async () => {
  const project = path.join(home, 'demo');
  fs.mkdirSync(path.join(project, '.secret'), { recursive:true });
  fs.writeFileSync(path.join(project, 'shot.png'), 'png');
  fs.writeFileSync(path.join(project, '.secret', 'key.txt'), 'nope');
  fs.writeFileSync(path.join(home, 'outside.txt'), 'nope');
  const dir = path.join(home, '.claude', 'projects', '-demo');
  fs.mkdirSync(dir, { recursive:true });
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type:'ai-title', aiTitle:'Demo task' },
    { type:'user', cwd:project, message:{ content:'make a screenshot' } },
    { type:'assistant', message:{ content:[{ type:'text', text:'Saved **shot.png**.' }] } },
  ].map(JSON.stringify).join('\n'));
  const homeData = (await call('/api/home', undefined, { cookie:mac })).body;
  assert.equal(homeData.sessions.find(s => s.id === id).title, 'Demo task');
  assert.deepEqual(homeData.projects, [project]);
  const chat = (await call(`/api/session?harness=claude&id=${id}&view=chat`, undefined, { cookie:mac })).body;
  assert.equal(chat.delivery, 'resume');
  assert.deepEqual(chat.messages.at(-1).files, ['shot.png']);
  const files = (await call(`/api/session?harness=claude&id=${id}&view=files`, undefined, { cookie:mac })).body.files;
  assert.deepEqual(files.map(f => f.path), ['shot.png']);
  const ok = await call(`/api/session/file?harness=claude&id=${id}&path=shot.png`, undefined, { cookie:mac });
  assert.deepEqual([ok.status, ok.text], [200, 'png']);
  for (const bad of ['../outside.txt', '.secret/key.txt', '/etc/hosts']) {
    assert.equal((await call(`/api/session/file?harness=claude&id=${id}&path=${encodeURIComponent(bad)}`, undefined, { cookie:mac })).status, 404, bad);
  }
});

test('subagents are listed per session with status, and their transcripts are readable', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(home, '.claude', 'projects', '-demo', id, 'subagents');
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, 'agent-abc123.jsonl'), [
    { type:'user', isSidechain:true, message:{ content:'Review the login page' } },
    { type:'assistant', isSidechain:true, message:{ stop_reason:'end_turn', content:[{ type:'text', text:'Found 2 issues.' }] } },
  ].map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(dir, 'agent-abc123.meta.json'), JSON.stringify({ agentType:'code-review', description:'Login review' }));
  fs.writeFileSync(path.join(dir, 'agent-def456.jsonl'), JSON.stringify({ type:'user', isSidechain:true, message:{ content:'Scan backend' } }));
  const home_ = (await call('/api/home', undefined, { cookie:mac })).body;
  assert.deepEqual(home_.sessions.find(s => s.id === id).subagents, { total:2, running:0 });
  const helpers = (await call(`/api/session?harness=claude&id=${id}&view=helpers`, undefined, { cookie:mac })).body.helpers;
  const review = helpers.find(h => h.id === 'abc123');
  assert.deepEqual([review.type, review.task, review.status, review.lastText], ['code-review', 'Login review', 'done', 'Found 2 issues.']);
  // Not finished, but the parent session is closed, so it is not running either.
  assert.equal(helpers.find(h => h.id === 'def456').status, 'stopped');
  const sub = (await call(`/api/session?harness=claude&id=${id}&agent=abc123`, undefined, { cookie:mac })).body;
  assert.deepEqual(sub.messages.map(m => m.text), ['Review the login page', 'Found 2 issues.']);
  assert.equal((await call(`/api/session?harness=claude&id=${id}&agent=..%2F..%2Fx`, undefined, { cookie:mac })).status, 404);
});

test('sessions can be renamed, and the name shows everywhere', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal((await call('/api/session/rename', { harness:'claude', id, name:'  Login   fixes ' }, { cookie:mac })).body.name, 'Login fixes');
  assert.equal((await call('/api/home', undefined, { cookie:mac })).body.sessions.find(s => s.id === id).name, 'Login fixes');
  assert.equal((await call(`/api/session?harness=claude&id=${id}&view=chat`, undefined, { cookie:mac })).body.session.name, 'Login fixes');
  await call('/api/session/rename', { harness:'claude', id, name:'' }, { cookie:mac });
  assert.equal((await call('/api/home', undefined, { cookie:mac })).body.sessions.find(s => s.id === id).name, '');
});

test('stopping refuses sessions that are not running', async () => {
  const r = await call('/api/session/stop', { harness:'claude', id:'11111111-2222-3333-4444-555555555555' }, { cookie:mac });
  assert.equal(r.status, 409);
});

test('lid-closed mode and Tailscale switches are Mac-only', async () => {
  const phone = (await call('/api/auth/login', { password:'correct horse', pair:auth.pairingCode().code }, { remote:true })).cookie;
  assert.equal((await call('/api/power/lid', { on:true }, { cookie:phone, remote:true })).status, 403);
  assert.equal((await call('/api/tailscale', { on:true }, { cookie:phone, remote:true })).status, 403);
});

test('start guide reflects real state, including a phone opened from its Home Screen', async () => {
  let st = (await call('/api/setup', undefined, { cookie:mac })).body;
  assert.equal(st.homeScreen, false);
  assert.equal(st.phoneSignedIn, true);
  const phone = (await call('/api/auth/login', { password:'correct horse', pair:auth.pairingCode().code }, { remote:true })).cookie;
  await call('/api/devices/me', { standalone:true }, { cookie:phone, remote:true });
  st = (await call('/api/setup', undefined, { cookie:mac })).body;
  assert.equal(st.homeScreen, true);
  assert.equal((await call('/api/service/install', {}, { cookie:phone, remote:true })).status, 403);
});

test('the app shell is installable: manifest and service worker are served', async () => {
  const m = await call('/manifest.webmanifest');
  const manifest = JSON.parse(m.text);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
  assert.ok(manifest.shortcuts.length >= 2);
  const sw = await call('/sw.js');
  assert.match(sw.text, /startsWith\('\/api\/'\)/);
});

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PORT } from './paths.js';
import { run } from './exec.js';
import * as auth from './auth.js';
import * as system from './system.js';
import * as updates from './updates.js';
import * as privacy from './privacy.js';
import * as agents from './agents.js';
import * as approvals from './approvals.js';
import * as terminal from './terminal.js';
import * as tunnel from './tunnel.js';
import * as tailscale from './tailscale.js';
import * as power from './power.js';
import * as preview from './preview.js';
import * as service from './service.js';
import { hasSubscriptions } from './push.js';
import * as push from './push.js';
import * as watcher from './watcher.js';
import { recentFiles, safePath, mime } from './files.js';
import { rename } from './names.js';
import { usage } from './usage.js';
import { hookStatus, installHook, uninstallHook } from './hookinstall.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const security = {
  'x-frame-options':'DENY',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { ...security, 'content-type':json ? 'application/json' : 'text/plain', 'cache-control':'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
async function readBody(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail('Request too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON'); }
}

// Lookout only listens on loopback. Phones arrive through cloudflared, which also connects from loopback but
// sends the tunnel's Host and Cloudflare headers, so "local" means loopback + localhost Host + no proxy headers.
const localHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const isLocal = req => localHosts.has(req.headers.host) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
const remoteHosts = () => [tunnel.remoteHost(), tailscale.remoteHost()].filter(Boolean);
const hostAllowed = req => localHosts.has(req.headers.host) || remoteHosts().includes(req.headers.host);
const clientIp = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
const localOnly = req => { if (!isLocal(req)) throw fail('Only possible on the Mac itself.', 403); };

// ---------- helpers for routes ----------
const pendingDevices = () => auth.listDevices().filter(d => !d.approved);
function needsYou() {
  const pending = approvals.list().pending;
  const waiting = [...agents.claudeLive()].filter(([id, s]) => s.status === 'waiting' && !pending.some(p => p.sessionId === id));
  return pending.length + waiting.length;
}
const updateCount = () => Object.values(updates.summary().sources).reduce((n, s) => n + (s.items?.length || 0), 0);

async function sessionDelivery(session) {
  if (!session.live) return { delivery:'resume', tty:'' };
  const tty = session.pid ? await terminal.ttyOf(session.pid) : '';
  if (tty && await terminal.inTerminal(tty)) return { delivery:'terminal', tty };
  const where = { 'claude-vscode':'VS Code', 'sdk-ts':'another app', cli:'another terminal app' }[session.entrypoint] || 'another app';
  return { delivery:'none', tty, note:`Open in ${where}. Send to continue in a copy in Terminal.` };
}

const routes = {
  'GET /api/badges':() => ({ needsYou:needsYou(), updates:updateCount(), devicesWaiting:pendingDevices().length }),
  'GET /api/home':async () => {
    const [stats, sessions, limits] = await Promise.all([system.stats(), agents.sessions({ limit:30 }), usage()]);
    return { stats, sessions, limits, approvals:approvals.list().pending, updates:updateCount(), devicesWaiting:pendingDevices(), projects:agents.projects(sessions) };
  },

  'GET /api/session':async (_, url) => {
    const harness = url.searchParams.get('harness');
    const id = url.searchParams.get('id') || '';
    const view = url.searchParams.get('view') || 'chat';
    const agent = url.searchParams.get('agent') || '';
    const session = await agents.findSession(harness, id);
    // A subagent is read-only: its transcript, with the parent session for context.
    if (agent) {
      const sub = session.subagents?.find(a => a.id === agent);
      if (!sub) throw fail('Subagent not found.', 404);
      return { session, subagent:sub, messages:agents.transcript(harness, id, session.cwd, { agent }) };
    }
    const { delivery, tty, note } = await sessionDelivery(session);
    const out = { session, delivery, deliveryNote:note || '', approvals:approvals.list().pending.filter(p => p.sessionId === id) };
    if (view === 'chat') out.messages = agents.transcript(harness, id, session.cwd);
    if (view === 'helpers') out.helpers = session.subagents || [];
    if (view === 'terminal') {
      if (delivery === 'terminal') {
        const screen = await terminal.readScreen(tty, 80);
        out.terminal = { tty, screen, choices:terminal.parseChoices(screen) };
      } else out.terminalNote = session.live ? note : 'This session is closed. Send a message from Chat to resume it in Terminal.';
    }
    if (view === 'files') out.files = recentFiles(session.cwd);
    return out;
  },
  'POST /api/session/send':async b => {
    const text = String(b.text || '').trim();
    if (!text || text.length > 20000) throw fail('Write a message first.');
    const session = await agents.findSession(String(b.harness), String(b.id));
    const { delivery, tty, note } = await sessionDelivery(session);
    if (delivery === 'terminal') await terminal.sendText(tty, session.harness, text);
    else if (delivery === 'resume') await agents.resume(session.harness, session.id, session.cwd, text);
    else throw fail(note, 409);
    return { ok:true, delivery };
  },
  'POST /api/session/rename':async b => {
    const session = await agents.findSession(String(b.harness), String(b.id));
    return { name:rename(session.harness, session.id, b.name) };
  },
  'POST /api/session/keys':async b => {
    const session = await agents.findSession(String(b.harness), String(b.id));
    const { delivery, tty, note } = await sessionDelivery(session);
    if (delivery !== 'terminal') throw fail(note || 'Not running in Terminal.', 409);
    await terminal.sendKey(tty, session.harness, String(b.key));
    return { ok:true };
  },
  'POST /api/agents/start':async b => {
    const started = await agents.start(String(b.harness), String(b.cwd || ''), String(b.prompt || ''), startOptions(b));
    if (started.id && b.name) rename(started.harness, started.id, b.name);
    return started;
  },
  'GET /api/agents/new':(_, url) => agents.findNew(url.searchParams.get('harness'), url.searchParams.get('cwd') || '', Number(url.searchParams.get('since')) || 0, url.searchParams.get('id') || ''),
  'POST /api/session/fork':async b => {
    const session = await agents.findSession(String(b.harness), String(b.id));
    const text = String(b.text || '').slice(0, 20000);
    const copy = await agents.fork(session.harness, session.id, session.cwd, text, startOptions(b));
    if (copy.id) rename(copy.harness, copy.id, `${session.name || session.title} (copy)`.slice(0, 80));
    return { ...copy, name:`${session.name || session.title} (copy)`.slice(0, 80) };
  },
  'GET /api/usage':(_, url) => usage({ force:url.searchParams.get('force') === '1' }),

  'GET /api/processes':() => system.processes(),
  'POST /api/processes/kill':async b => { system.killProcess(b.pid, b.force ? 'SIGKILL' : 'SIGTERM'); return { ok:true }; },
  'GET /api/ports':() => system.ports(),
  'GET /api/startup':() => system.startupItems(),
  'POST /api/startup/action':b => system.startupAction(String(b.label), String(b.action)),
  'POST /api/startup/reveal':async (b, _, req) => {
    localOnly(req);
    const item = (await system.startupItems()).find(i => i.label === b.label);
    if (!item) throw fail('Unknown startup item.', 404);
    await system.reveal(item.file);
    return { ok:true };
  },
  'GET /api/updates':() => updates.summary(),
  'POST /api/updates/refresh':() => { updates.refresh(); return { ok:true }; },
  'POST /api/updates/upgrade':b => updates.upgrade(String(b.id)),
  'POST /api/updates/upgrade-all':b => updates.upgradeAll(String(b.source)),
  'POST /api/updates/open-macos':async (_, __, req) => { localOnly(req); await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.Software-Update-Settings.extension']); return { ok:true }; },
  'GET /api/privacy':() => privacy.permissions(),
  'POST /api/privacy/revoke':b => privacy.revoke(String(b.service), String(b.client)),
  'POST /api/privacy/open':async (b, _, req) => { localOnly(req); await privacy.openPane(String(b.service || '')); return { ok:true }; },

  'GET /api/approvals':() => approvals.list(),
  'POST /api/approvals/decide':b => { approvals.decide(String(b.id), String(b.decision), b.message ? String(b.message).slice(0, 2000) : ''); return { ok:true }; },
  'POST /api/approvals/settings':b => approvals.updateSettings(b),
  'POST /api/approvals/hook':(b, _, req) => { localOnly(req); return b.install ? installHook() : uninstallHook(); },

  'GET /api/settings':async (_, __, req, device) => {
    const local = isLocal(req);
    const installed = Boolean(await tunnel.binary());
    let pairingAt = 0;
    if (local && phoneUrl()) pairingAt = currentPairing().createdAt;
    return {
      tailscale:await tailscale.status(), power:await power.status(), phoneUrl:phoneUrl(),
      tunnel:{ ...tunnel.status(), status:installed ? tunnel.status().status : 'missing' }, installingCloudflared:updates.installing('cloudflared'), pairingAt,
      hook:hookStatus(), approvals:approvals.settings(), history:approvals.list().history,
      devices:auth.listDevices(), deviceId:device.id,
    };
  },
  'POST /api/tailscale':async (b, _, req) => { localOnly(req); return tailscale.setServing(Boolean(b.on)); },
  'POST /api/tailscale/open':async (_, __, req) => { localOnly(req); await run('/usr/bin/open', ['-a', 'Tailscale']).then(r => r.ok ? r : run('/usr/bin/open', ['https://tailscale.com/download/mac'])); return { ok:true }; },
  'POST /api/power/keep-awake':b => power.setKeepAwake(String(b.mode)),
  'POST /api/power/lid':async (b, _, req) => { localOnly(req); return power.setLidClosed(Boolean(b.on)); },
  'POST /api/power/lock':async () => { await power.lock(); return { ok:true }; },
  'POST /api/power/sleep':async () => { await power.sleepNow(); return { ok:true }; },
  'POST /api/session/stop':async b => {
    const session = await agents.findSession(String(b.harness), String(b.id));
    if (!session.live || !session.pid) throw fail('That session is not running.', 409);
    await agents.stop(session.pid);
    return { ok:true };
  },
  'GET /api/preview':async () => ({ ...preview.status(), servers:preview.candidates(await system.ports()) }),
  'POST /api/preview/open':(b, _, req) => preview.open(b.port, { local:isLocal(req) }),
  'POST /api/preview/stop':() => { preview.stop(); return { ok:true }; },
  // The start guide: each step is checked against the real state of the Mac, so it ticks itself off.
  'GET /api/setup':async () => {
    const [ts, pw, svc] = await Promise.all([tailscale.status(), power.status(), service.status()]);
    const devices = auth.listDevices();
    return {
      phoneLink:ts.serving || tunnel.status().status === 'on',
      tailscale:ts.state, tailscaleServing:Boolean(ts.serving), cloudflare:tunnel.status().status,
      phoneSignedIn:devices.some(d => d.remote && d.approved),
      homeScreen:devices.some(d => d.remote && d.approved && d.standalone),
      notifications:hasSubscriptions(),
      approvals:hookStatus().installed,
      keepAwake:pw.keepAwake !== 'off', lockReady:pw.lockImmediate,
      startAtLogin:svc.installed && svc.loaded,
      runningAsService:svc.runningAsService,
    };
  },
  'POST /api/devices/me':(b, _, __, device) => { auth.noteDevice(device.id, { standalone:b.standalone === true }); return { ok:true }; },
  'POST /api/service/install':async (_, __, req) => {
    localOnly(req);
    await service.install();
    // Hand the port over to the background copy: start it, then step aside if this copy was started by hand.
    setTimeout(async () => {
      const st = await service.status();
      await service.load().catch(error => console.error(error));
      if (!st.runningAsService) process.exit(0);
    }, 300);
    return { ok:true };
  },
  'POST /api/tunnel':async (b, _, req) => { localOnly(req); return b.on ? tunnel.start() : tunnel.stop(); },
  'POST /api/tunnel/install':async (_, __, req) => {
    localOnly(req);
    updates.brewInstall('cloudflared').then(job => { if (job.status === 'done') tunnel.start(); });
    return { ok:true };
  },
  'GET /api/pair/qr':async (_, __, req) => {
    localOnly(req);
    const url = phoneUrl();
    if (!url) throw fail('Turn on phone access first.', 409);
    const svg = await QRCode.toString(`${url}/#pair=${currentPairing().code}`, { type:'svg', margin:1, color:{ dark:'#2b2620', light:'#fffdf8' } });
    return { raw:svg, type:'image/svg+xml' };
  },

  'GET /api/push/key':() => ({ key:push.publicKey() }),
  'POST /api/push/subscribe':(b, _, __, device) => { push.subscribe(device.id, b.subscription); return { ok:true }; },
  'POST /api/push/unsubscribe':(_, __, ___, device) => { push.unsubscribe(device.id); return { ok:true }; },
  'POST /api/push/test':() => push.notify({ title:'Lookout', body:'Notifications are working.', url:'/', tag:'test' }).then(() => ({ ok:true })),

  'POST /api/devices/approve':(b, _, req) => { localOnly(req); auth.setApproval(String(b.id), true); return { ok:true }; },
  'POST /api/devices/remove':(b, _, __, device) => {
    if (String(b.id) === device.id) throw fail('Use Sign out for this device.');
    auth.setApproval(String(b.id), false);
    push.unsubscribe(String(b.id));
    return { ok:true };
  },
  'POST /api/devices/others':(_, __, ___, device) => { auth.signOutOthers(device.id); return { ok:true }; },
};

const currentPairing = auth.pairingCode;
// The link phones should use: the private Tailscale address if it is on, else the Cloudflare one.
const phoneUrl = () => (tailscale.remoteHost() ? `https://${tailscale.remoteHost()}` : tunnel.status().url);
const startOptions = b => ({ model:String(b.model || ''), skipPermissions:b.skipPermissions === true, name:String(b.name || '') });

async function handleAuth(req, res, url) {
  const key = `${req.method} ${url.pathname}`;
  const local = isLocal(req);
  const secure = local ? '' : '; Secure';
  const cookie = token => ({ 'set-cookie':`lookout=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure}` });
  if (key === 'GET /api/auth/state') {
    const device = auth.deviceFor(auth.cookieToken(req));
    return send(res, 200, { setup:auth.hasPassword(), local, authed:Boolean(device), approved:Boolean(device?.approved), device:device ? { name:device.name } : null });
  }
  const body = await readBody(req, 4096);
  if (key === 'POST /api/auth/setup') {
    if (!local) throw fail('Set the password on the Mac itself.', 403);
    if (auth.hasPassword()) throw fail('A password is already set.', 409);
    auth.setPassword(body.password);
    return send(res, 200, { ok:true }, cookie(auth.createDevice({ local:true, userAgent:req.headers['user-agent'] }).token));
  }
  if (key === 'POST /api/auth/login') {
    const ip = clientIp(req);
    if (!auth.loginAllowed(ip)) throw fail('Too many attempts. Wait a minute.', 429);
    if (!auth.checkPassword(body.password)) {
      if (auth.recordFailure(ip) === 20) push.notify({ title:'Lookout: many failed sign-ins', body:'20 wrong passwords in the last hour.', url:'/#/settings' });
      throw fail('Wrong password.', 401);
    }
    const paired = !local && auth.usePairingCode(body.pair);
    const { token, device } = auth.createDevice({ local, userAgent:req.headers['user-agent'], ip, paired });
    return send(res, device.approved ? 200 : 202, { ok:true, approved:device.approved }, cookie(token));
  }
  if (key === 'POST /api/auth/logout') {
    const device = auth.deviceFor(auth.cookieToken(req));
    if (device) push.unsubscribe(device.id);
    auth.endDevice(auth.cookieToken(req));
    return send(res, 200, { ok:true }, { 'set-cookie':`lookout=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
  }
  throw fail('Not found', 404);
}

async function handleHook(req, res) {
  if (!isLocal(req) || !auth.validHookToken(req.headers['x-lookout-token'])) throw fail('Forbidden', 403);
  const { id, answer } = approvals.request(await readBody(req));
  let settled = false;
  // Claude stops the hook when the person answers in the terminal; drop the card when that happens.
  res.on('close', () => { if (!settled) approvals.cancel(id); });
  const result = await answer;
  settled = true;
  if (!res.destroyed) send(res, 200, result || { decision:null });
}

async function serveFile(req, res, url) {
  const session = await agents.findSession(url.searchParams.get('harness'), url.searchParams.get('id') || '');
  const file = safePath(session.cwd, url.searchParams.get('path') || '');
  if (!file) throw fail('File not available.', 404);
  const stat = fs.statSync(file);
  const type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { ...security, 'content-type':type, 'accept-ranges':'bytes', 'cache-control':'private, max-age=60' };
  if (url.searchParams.get('download')) headers['content-disposition'] = `attachment; filename="${path.basename(file).replace(/["\\\r\n]/g, '_')}"`;
  // Video on iOS needs range requests.
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { ...headers, 'content-range':`bytes ${start}-${end}/${stat.size}`, 'content-length':end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length':stat.size });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(publicDir)) return send(res, 404, 'Not found');
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, 'Not found');
    res.writeHead(200, { ...security, 'content-type':types[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' });
    res.end(data);
  });
}

export function createServer() {
  // The hook script reads this file, so it must exist before any Claude session asks.
  auth.hookToken();
  return http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) throw fail('Bad host', 421);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/hook/permission' && req.method === 'POST') return await handleHook(req, res);
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      // Browsers cannot add custom headers cross-site without a preflight we never approve, so this blocks CSRF.
      if (req.method !== 'GET' && req.headers['x-lookout'] !== '1') throw fail('Missing x-lookout header', 403);
      if (url.pathname.startsWith('/api/auth/')) return await handleAuth(req, res, url);
      const device = auth.deviceFor(auth.cookieToken(req));
      if (!device) throw fail('Sign in first.', 401);
      if (!device.approved) throw fail('Waiting for approval on the Mac.', 423);
      if (url.pathname === '/api/session/file' && req.method === 'GET') return await serveFile(req, res, url);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw fail('Not found', 404);
      const body = req.method === 'POST' ? await readBody(req) : null;
      const result = await handler(body, url, req, device);
      if (result?.raw) return send(res, 200, result.raw, { 'content-type':result.type });
      send(res, 200, result ?? { ok:true });
    } catch (error) {
      // Unexpected failures are logged in full on the Mac; the phone gets a plain sentence.
      if (!error.status) console.error(error);
      if (!res.headersSent) send(res, error.status || 500, { error:error.status ? error.message : 'Something went wrong on your Mac. Try again.' });
    }
  });
}

export function main() {
  updates.refresh();
  system.startupItems().catch(() => {});
  watcher.start();
  tunnel.boot();
  tailscale.boot();
  power.apply();
  createServer().listen(PORT, '127.0.0.1', () => console.log(`Lookout running at http://localhost:${PORT}`));
  preview.createProxy().listen(preview.PREVIEW_PORT, '127.0.0.1');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

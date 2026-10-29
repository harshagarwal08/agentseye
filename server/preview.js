import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PORT } from './paths.js';
import { run } from './exec.js';
import * as tunnel from './tunnel.js';
import * as tailscale from './tailscale.js';

// Preview a dev server running on the Mac (say localhost:3000) from your phone.
// A second listener on loopback forwards every request, including websockets for hot reload, to the chosen port.
// It is a separate origin from Lookout so the app's absolute paths (/assets/x.js) just work, and it only serves
// browsers holding a preview cookie that Lookout hands out to signed-in devices.
export const PREVIEW_PORT = Number(process.env.LOOKOUT_PREVIEW_PORT || PORT + 10);
const state = { target:0, cfUrl:'', cfChild:null, tsUrl:'' };
const passes = new Map();
const sessions = new Set();
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

const cookieOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)lookout_preview=([^;]+)/)?.[1] || '';
const authed = req => sessions.has(sha(cookieOf(req)));

// Lookout's own process, the preview proxy and system services are never offered as previews.
const devPrograms = /^(node|bun|deno|python[\d.]*|ruby|php|java|go|cargo|rails|uvicorn|gunicorn|vite|next-server|esbuild|hugo|jekyll|dotnet|beam\.smp|flask)/i;
export function candidates(ports) {
  const own = new Set([PORT, PREVIEW_PORT]);
  const seen = new Set();
  return ports.filter(p => p.protocol === 'TCP' && p.port >= 1024 && !own.has(p.port) && devPrograms.test(p.command) && !seen.has(p.port) && seen.add(p.port))
    .map(p => ({ port:p.port, command:p.command, pid:p.pid }));
}

async function startCloudflare() {
  if (state.cfChild || !tunnel.status().url) return;
  const bin = await tunnel.binary();
  if (!bin) return;
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PREVIEW_PORT}`], { stdio:['ignore', 'pipe', 'pipe'] });
  state.cfChild = child;
  const scan = c => { const m = String(c).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) state.cfUrl = m[0]; };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', () => { state.cfChild = null; state.cfUrl = ''; });
}

async function startTailscale() {
  if (!tailscale.remoteHost()) return;
  const st = await tailscale.status();
  if (!st.serving) return;
  const bin = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  for (const b of bin) {
    const r = await run(b, ['serve', '--bg', '--https=8443', `http://127.0.0.1:${PREVIEW_PORT}`]);
    if (r.ok) { state.tsUrl = `https://${st.dns}:8443`; return; }
  }
}

// Picks the port and returns a one-time link that signs this device in to the preview origin.
export async function open(port, { local }) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === PORT || port === PREVIEW_PORT) throw Object.assign(new Error('Pick a dev server port.'), { status:400 });
  const reachable = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(true); }); s.on('error', () => resolve(false)); });
  if (!reachable) throw Object.assign(new Error(`Nothing is answering on port ${port}.`), { status:409 });
  state.target = port;
  let base = `http://localhost:${PREVIEW_PORT}`;
  if (!local) {
    await startTailscale();
    if (!state.tsUrl) {
      await startCloudflare();
      for (let i = 0; i < 40 && !state.cfUrl; i++) await new Promise(r => setTimeout(r, 250));
    }
    base = state.tsUrl || state.cfUrl;
    if (!base) throw Object.assign(new Error('Turn on phone access first.'), { status:409 });
  }
  const pass = crypto.randomBytes(24).toString('base64url');
  passes.set(pass, Date.now() + 60000);
  return { url:`${base}/__lookout/enter?t=${pass}`, port };
}

let closeAll = () => {};
export function stop() {
  state.target = 0;
  closeAll();
  state.cfChild?.kill();
  sessions.clear();
}
export const status = () => ({ port:state.target });

function deny(res, code, text) {
  res.writeHead(code, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px -apple-system,sans-serif;padding:40px;text-align:center;background:#f6f1e7;color:#2b2620"><h2>${text}</h2><p>Open the preview again from Lookout.</p></body>`);
}

export function createProxy() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__lookout/enter') {
      const t = url.searchParams.get('t') || '';
      const exp = passes.get(t);
      passes.delete(t);
      if (!exp || Date.now() > exp) return deny(res, 403, 'This preview link has expired.');
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.add(sha(token));
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor']?.includes('https') || req.headers['tailscale-user-login'] ? '; Secure' : '';
      res.writeHead(302, { location:'/', 'set-cookie':`lookout_preview=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` });
      return res.end();
    }
    if (!authed(req)) return deny(res, 401, 'Not signed in to this preview.');
    if (!state.target) return deny(res, 410, 'No preview is open.');
    const headers = { ...req.headers, host:`localhost:${state.target}` };
    delete headers['accept-encoding'];
    headers.cookie = String(headers.cookie || '').split(/;\s*/).filter(c => c && !c.startsWith('lookout_preview=')).join('; ') || undefined;
    if (!headers.cookie) delete headers.cookie;
    const upstream = http.request({ host:'127.0.0.1', port:state.target, method:req.method, path:req.url, headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => deny(res, 502, `The dev server on port ${state.target} is not answering.`));
    req.pipe(upstream);
  });
  // Websockets (hot reload) are piped through as raw sockets after the same cookie check. They are tracked so
  // stopping the preview (or the server) closes them instead of leaving the dev server reachable.
  const piped = new Set();
  const track = (...socks) => socks.forEach(k => { piped.add(k); k.on('close', () => piped.delete(k)); });
  server.on('close', () => piped.forEach(k => k.destroy()));
  closeAll = () => piped.forEach(k => k.destroy());
  server.on('upgrade', (req, socket, head) => {
    if (!authed(req) || !state.target) return socket.destroy();
    const up = net.connect(state.target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const [k, v] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? `localhost:${state.target}` : v}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    track(up, socket);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return server;
}

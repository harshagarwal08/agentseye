// AgentsEye relay: lets a phone reach a Mac that can only make outbound connections (company laptops, NAT, proxies).
// The Mac keeps one WebSocket open to the relay; each phone request is sent down it and the reply streamed back.
// Everything private travels end-to-end encrypted between phone and Mac (see public/e2e.js); the relay only routes.
// Written against web-standard Request/Response so it runs on Cloudflare Workers and on Node (server.js).

import { installScript } from './install.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#211d18"/><path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" fill="#f6f1e7"/><circle cx="32" cy="32" r="11" fill="#c8553d"/><path d="M27 27.5 L31.5 32 L27 36.5" fill="none" stroke="#fffdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="33" y1="37" x2="38" y2="37" stroke="#fffdf8" stroke-width="3" stroke-linecap="round"/></svg>';

export const MAC_ID = /^[a-z2-7]{16}$/;
const MAX_BODY = 900 * 1024;          // one frame; Cloudflare allows 1 MiB per WebSocket message
const HEAD_TIMEOUT = 60000;
const IDLE_TIMEOUT = 120000;
const enc = new TextEncoder();

const b64 = bytes => { let s = ''; const v = new Uint8Array(bytes); for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Request headers worth passing on; hop-by-hop and proxy headers are dropped.
const FORWARD = ['accept', 'accept-language', 'content-type', 'cookie', 'if-none-match', 'if-modified-since', 'range', 'user-agent', 'x-agentseye'];

const offlinePage = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentsEye</title>
<body style="font:16px -apple-system,system-ui,sans-serif;background:#f6f1e7;color:#2b2620;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="margin:0 0 8px">Can't reach your Mac</h1><p style="color:#857c6e">AgentsEye on your Mac isn't connected to the relay right now.<br>Check that the Mac is awake and online.</p><p style="color:#857c6e;font-size:13px">This page retries every few seconds.</p></div>
<script>setTimeout(()=>location.reload(),5000)</script>`;

// The product page: what AgentsEye is and the one line that installs it, pointed at this relay.
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
const landing = (origin, repo) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentsEye — your coding agents, on your phone</title>
<meta name="description" content="See and control Claude Code and Codex on your Mac from your phone. Nothing to install on company Macs, end-to-end encrypted, free.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">
<style>
body{margin:0;font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f6f1e7;color:#2b2620}
main{max-width:720px;margin:0 auto;padding:56px 22px 80px}
.logo{width:76px;height:76px;border-radius:18px;box-shadow:0 8px 24px #0002}
h1{font-size:42px;line-height:1.05;letter-spacing:-.02em;margin:22px 0 10px}
.lede{font-size:20px;color:#6b6356;margin:0 0 28px}
.cmd{display:flex;gap:8px;align-items:center;background:#211d18;color:#f6f1e7;border-radius:14px;padding:14px 16px;font:14px ui-monospace,Menlo,monospace;overflow-x:auto}
.cmd code{flex:1;white-space:nowrap}
button{font:600 14px -apple-system,system-ui;border:0;border-radius:10px;padding:8px 12px;background:#c8553d;color:#fff;cursor:pointer}
.small{font-size:14px;color:#857c6e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:34px 0}
.card{background:#fffdf8;border-radius:16px;padding:16px}
.card b{display:block;margin-bottom:4px}
ol{padding-left:20px}li{margin:6px 0}
a{color:#c8553d}
</style>
<main>
<img class="logo" alt="" src="data:image/svg+xml,${encodeURIComponent(ICON)}">
<h1>Your coding agents,<br>in your pocket.</h1>
<p class="lede">AgentsEye shows every Claude Code and Codex session on your Mac, lets you answer them, approve their requests and start new ones — from your phone, anywhere.</p>
<div class="cmd"><code id="c">curl -fsSL ${esc(origin)}/install.sh | sh</code><button onclick="navigator.clipboard.writeText(document.getElementById('c').textContent);this.textContent='Copied'">Copy</button></div>
<p class="small">Paste into Terminal on your Mac. No admin rights or Homebrew needed. macOS only.</p>
<div class="grid">
<div class="card"><b>👀 Everything at a glance</b>Live sessions, subagents, usage limits, and what your Mac is up to.</div>
<div class="card"><b>💬 Reply and approve</b>Chat with agents, answer their questions, allow or deny their commands.</div>
<div class="card"><b>🔒 Encrypted end to end</b>Phone and Mac share a key from your password. This relay only passes along ciphertext.</div>
<div class="card"><b>🏢 Works on company Macs</b>Only an outbound HTTPS connection. No tunnels, no open ports, nothing installed system-wide.</div>
</div>
<h2>Get started</h2>
<ol><li>Run the line above on your Mac. AgentsEye opens in your browser.</li><li>Choose a password, then scan the QR code with your phone.</li><li>Add it to your Home Screen and turn on notifications.</li></ol>
<p class="small">Free and open source${repo ? ` · <a href="https://github.com/${esc(repo)}">Source on GitHub</a>` : ''} · <a href="/privacy">Privacy</a> · Remove any time: <code>curl -fsSL ${esc(origin)}/install.sh | sh -s -- --uninstall</code></p>
</main></html>`;

const privacy = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentsEye privacy</title>
<body style="font:17px/1.6 -apple-system,system-ui,sans-serif;background:#f6f1e7;color:#2b2620;max-width:680px;margin:0 auto;padding:48px 22px">
<h1>Privacy</h1>
<p>AgentsEye runs on your Mac. Your sessions, files, commands and password never leave it except to reach your own phone.</p>
<p><b>What this relay sees:</b> an id for your Mac, a hash of its connection secret, and when and how much encrypted data passes between your phone and your Mac. Everything private is encrypted end to end with a key derived from your password, which the relay never receives.</p>
<p><b>What it stores:</b> only the hash of each Mac's connection secret, so nobody else can take over its address. No accounts, no analytics, no cookies besides the one that remembers which Mac your phone opens.</p>
<p><b>What it can't do:</b> read your data, or sign in as you. If you prefer not to trust anyone, run your own relay for free — the code is open.</p>
</body>`;

// One Room per Mac. It owns that Mac's socket and the requests waiting on it.
export class Room {
  constructor({ verify }) {
    this.verify = verify;       // async (macId, secret) => boolean; registers the secret on first use
    this.socket = null;
    this.macId = null;
    this.pending = new Map();
    this.next = 1;
  }

  get online() { return Boolean(this.socket); }

  // A Mac socket must say hello with its id and secret within 10 s, or it is closed.
  attach(socket, macId) {
    let authed = false;
    const timer = setTimeout(() => { if (!authed) socket.close(4001, 'hello timeout'); }, 10000);
    return {
      message:async text => {
        let m;
        try { m = JSON.parse(text); } catch { return; }
        if (!authed) {
          if (m.t !== 'hello' || m.mac !== macId || !(await this.verify(macId, String(m.secret || '')))) { socket.close(4003, 'not allowed'); return; }
          authed = true;
          clearTimeout(timer);
          // A newer connection from the same Mac replaces the old one (after a network change, say).
          this.socket?.close(4000, 'replaced');
          this.socket = socket;
          this.macId = macId;
          socket.send(JSON.stringify({ t:'welcome' }));
          return;
        }
        if (socket !== this.socket) return;
        this.receive(m);
      },
      close:() => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = null;
        for (const p of this.pending.values()) p.fail('Your Mac disconnected.');
        this.pending.clear();
      },
    };
  }

  receive(m) {
    if (m.t === 'ping') { this.socket.send(JSON.stringify({ t:'pong' })); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    p.touch();
    if (m.t === 'head') p.head(m);
    else if (m.t === 'body') p.chunk(unb64(m.data));
    else if (m.t === 'end') { p.end(); this.pending.delete(m.id); }
    else if (m.t === 'error') { p.fail(m.message || 'AgentsEye on your Mac failed.'); this.pending.delete(m.id); }
  }

  async forward(request, { ip = '' } = {}) {
    const accept = request.headers.get('accept') || '';
    if (!this.socket) return accept.includes('text/html') ? new Response(offlinePage, { status:503, headers:{ 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' } }) : new Response('Mac offline', { status:503, headers:{ 'cache-control':'no-store' } });
    const body = ['GET', 'HEAD'].includes(request.method) ? null : new Uint8Array(await request.arrayBuffer());
    if (body && body.length > MAX_BODY) return new Response('Request too large', { status:413 });
    const url = new URL(request.url);
    const headers = {};
    for (const h of FORWARD) { const v = request.headers.get(h); if (v) headers[h] = v; }
    const id = this.next++;
    const socket = this.socket;
    return new Promise(resolve => {
      let controller;
      let settled = false;
      let idle;
      const stream = new ReadableStream({ start(c) { controller = c; } });
      const p = {
        touch:() => { clearTimeout(idle); idle = setTimeout(() => p.fail('Your Mac stopped answering.'), IDLE_TIMEOUT); },
        head:m => {
          if (settled) return;
          settled = true;
          clearTimeout(headTimer);
          const out = new Headers();
          for (const [k, v] of m.headers || []) out.append(k, v);
          resolve(new Response([204, 304].includes(m.status) || request.method === 'HEAD' ? null : stream, { status:m.status, headers:out }));
        },
        chunk:bytes => { try { controller.enqueue(bytes); } catch {} },
        end:() => { clearTimeout(idle); try { controller.close(); } catch {} },
        fail:message => {
          clearTimeout(idle);
          clearTimeout(headTimer);
          if (!settled) { settled = true; resolve(new Response(message, { status:503, headers:{ 'cache-control':'no-store' } })); }
          else try { controller.error(new Error(message)); } catch {}
        },
      };
      const headTimer = setTimeout(() => { p.fail('Your Mac took too long to answer.'); this.pending.delete(id); }, HEAD_TIMEOUT);
      this.pending.set(id, p);
      p.touch();
      socket.send(JSON.stringify({ t:'req', id, method:request.method, path:url.pathname + url.search, headers, ip, host:url.host, proto:url.protocol.replace(':', ''), body:body ? b64(body) : null }));
    });
  }
}

// Routes that don't need a Mac: the landing page, health, and /m/<id> which remembers the Mac in a cookie and
// sends the browser to "/" so the app's absolute paths work unchanged. Returns null when the request is for a Mac.
export function route(request, { repo = '' } = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return { response:new Response('ok') };
  if (url.pathname === '/install.sh') return { response:new Response(installScript({ relay:url.origin, repo }), { headers:{ 'content-type':'text/x-shellscript; charset=utf-8', 'cache-control':'no-cache' } }) };
  if (url.pathname === '/privacy') return { response:new Response(privacy, { headers:{ 'content-type':'text/html; charset=utf-8' } }) };
  if (url.pathname === '/icon.svg' && !/agentseye_mac=/.test(request.headers.get('cookie') || '')) return { response:new Response(ICON, { headers:{ 'content-type':'image/svg+xml', 'cache-control':'max-age=86400' } }) };
  // /m/<id> remembers the Mac in a cookie and lands on /?mac=<id>, so the address bar always names the Mac:
  // copying it into another browser (Chrome → Safari on iPhone) still opens the same Mac.
  const m = url.pathname.match(/^\/m\/([a-z2-7]{16})\/?$/);
  if (m) {
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    const next = new URLSearchParams(url.search);
    next.set('mac', m[1]);
    return { response:new Response(null, { status:302, headers:{ location:`/?${next}`, 'set-cookie':`agentseye_mac=${m[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`, 'cache-control':'no-store' } }) };
  }
  const cookieMac = (request.headers.get('cookie') || '').match(/(?:^|;\s*)agentseye_mac=([a-z2-7]{16})/)?.[1];
  const queryMac = url.searchParams.get('mac');
  // A pasted ?mac= link in a browser without the cookie: set it once via /m/<id>, then carry on.
  if (queryMac && /^[a-z2-7]{16}$/.test(queryMac) && queryMac !== cookieMac && url.pathname === '/') {
    const rest = new URLSearchParams(url.search);
    rest.delete('mac');
    return { response:new Response(null, { status:302, headers:{ location:`/m/${queryMac}${rest.size ? `?${rest}` : ''}`, 'cache-control':'no-store' } }) };
  }
  const macId = cookieMac;
  if (!macId) return { response:new Response(landing(url.origin, repo), { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } }) };
  return { macId };
}

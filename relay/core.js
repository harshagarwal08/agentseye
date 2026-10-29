// Lookout relay: lets a phone reach a Mac that can only make outbound connections (company laptops, NAT, proxies).
// The Mac keeps one WebSocket open to the relay; each phone request is sent down it and the reply streamed back.
// Everything private travels end-to-end encrypted between phone and Mac (see public/e2e.js); the relay only routes.
// Written against web-standard Request/Response so it runs on Cloudflare Workers and on Node (server.js).

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
const FORWARD = ['accept', 'accept-language', 'content-type', 'cookie', 'if-none-match', 'if-modified-since', 'range', 'user-agent', 'x-lookout'];

const offlinePage = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lookout</title>
<body style="font:16px -apple-system,system-ui,sans-serif;background:#f6f1e7;color:#2b2620;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="margin:0 0 8px">Can't reach your Mac</h1><p style="color:#857c6e">Lookout on your Mac isn't connected to the relay right now.<br>Check that the Mac is awake and online.</p><p style="color:#857c6e;font-size:13px">This page retries every few seconds.</p></div>
<script>setTimeout(()=>location.reload(),5000)</script>`;

const landing = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lookout relay</title>
<body style="font:16px -apple-system,system-ui,sans-serif;background:#f6f1e7;color:#2b2620;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="margin:0 0 8px">Lookout relay</h1><p style="color:#857c6e">Open the link from your Mac's QR code (Lookout → Settings) to reach it from here.</p></div>`;

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
    else if (m.t === 'error') { p.fail(m.message || 'Lookout on your Mac failed.'); this.pending.delete(m.id); }
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
export function route(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return { response:new Response('ok') };
  const m = url.pathname.match(/^\/m\/([a-z2-7]{16})\/?$/);
  if (m) {
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return { response:new Response(null, { status:302, headers:{ location:`/${url.search}`, 'set-cookie':`lookout_mac=${m[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`, 'cache-control':'no-store' } }) };
  }
  const macId = (request.headers.get('cookie') || '').match(/(?:^|;\s*)lookout_mac=([a-z2-7]{16})/)?.[1];
  if (!macId) return { response:new Response(landing, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } }) };
  return { macId };
}

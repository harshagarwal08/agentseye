import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA, PORT, readJson, writeJson } from './paths.js';

// The Mac side of the relay: one outbound WebSocket (ordinary HTTPS traffic, so it works behind company proxies
// and needs nothing installed). Requests arriving on it are replayed against AgentsEye on loopback and the replies
// streamed back. AgentsEye only accepts them as relay traffic when they carry this process's random token.
export const RELAY_TOKEN = crypto.randomBytes(24).toString('hex');
const file = path.join(DATA, 'relay.json');
const CHUNK = 192 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length']);
const base32 = bytes => [...bytes].map(b => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');

const state = { status:'off', error:'', socket:null, retries:0, timer:null, ping:null, port:PORT, heardAt:0 };

export function settings() {
  let s = readJson(file, null);
  if (!s?.macId) {
    // The id names this Mac on the relay; the secret proves it is the same Mac next time.
    s = { url:process.env.AGENTSEYE_RELAY_URL || '', enabled:false, macId:base32(crypto.randomBytes(16)), secret:crypto.randomBytes(32).toString('base64url') };
    writeJson(file, s);
  }
  return s;
}
const origin = url => String(url || '').replace(/\/+$/, '');
export const link = () => { const s = settings(); return s.url && state.status === 'on' ? `${origin(s.url)}/m/${s.macId}` : ''; };
export const relayHost = () => { try { return new URL(settings().url).host; } catch { return ''; } };
export function status() {
  const s = settings();
  return { enabled:s.enabled, url:s.url, status:state.status, error:state.error, link:link(), macId:s.macId };
}

export function configure({ url, enabled }) {
  const s = settings();
  if (url !== undefined) {
    const clean = origin(url);
    if (clean && !/^https?:\/\/[^\s/]+$/.test(clean)) throw Object.assign(new Error('Enter the relay address, like https://agentseye-relay.you.workers.dev'), { status:400 });
    s.url = clean;
  }
  if (enabled !== undefined) s.enabled = Boolean(enabled);
  writeJson(file, s);
  disconnect();
  if (s.enabled && s.url) connect();
  return status();
}

function disconnect() {
  clearTimeout(state.timer);
  clearInterval(state.ping);
  const sock = state.socket;
  state.socket = null;
  try { sock?.close(); } catch {}
  state.status = settings().enabled ? 'connecting' : 'off';
}

function connect() {
  const s = settings();
  if (!s.enabled || !s.url) { state.status = 'off'; return; }
  state.status = state.status === 'on' ? 'on' : 'connecting';
  let ws;
  try { ws = new WebSocket(`${origin(s.url).replace(/^http/, 'ws')}/connect?mac=${s.macId}`); }
  catch (error) { state.error = error.message; return retry(); }
  state.socket = ws;
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t:'hello', mac:s.macId, secret:s.secret })));
  ws.addEventListener('message', event => {
    state.heardAt = Date.now();
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m.t === 'welcome') {
      if (state.retries) console.log(`${new Date().toISOString()} relay: connected`);
      state.status = 'on';
      state.error = '';
      state.retries = 0;
      clearInterval(state.ping);
      // Proxies and platforms drop quiet sockets; a small ping keeps the line open.
      // The relay answers every ping. Silence for 50 seconds means the line died quietly (Wi-Fi change, sleep,
      // a proxy dropping it), which never fires "close", so drop it and dial again.
      state.heardAt = Date.now();
      state.ping = setInterval(() => {
        if (Date.now() - state.heardAt > 50000) { if (state.socket === ws) { console.log(`${new Date().toISOString()} relay: no answer for 50s, reconnecting`); state.socket = null; clearInterval(state.ping); try { ws.close(); } catch {} retry(); } return; }
        try { ws.send('{"t":"ping"}'); } catch {}
      }, 15000);
    } else if (m.t === 'req') handle(ws, m);
  });
  ws.addEventListener('close', event => {
    if (state.socket !== ws) return;
    console.log(`${new Date().toISOString()} relay: disconnected (${event.code}${event.reason ? ` ${event.reason}` : ''}), reconnecting`);
    state.socket = null;
    clearInterval(state.ping);
    if (event.code === 4003) { state.status = 'error'; state.error = 'The relay refused this Mac (its id belongs to another secret).'; return; }
    retry();
  });
  ws.addEventListener('error', () => { state.error = 'Could not reach the relay.'; });
}

function retry() {
  if (!settings().enabled) return;
  state.status = 'connecting';
  const delay = Math.min(10000, 1000 * 2 ** state.retries++);
  clearTimeout(state.timer);
  state.timer = setTimeout(connect, delay);
}

// Replays one request against AgentsEye on loopback and streams the reply back in chunks.
function handle(ws, m) {
  const send = obj => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const headers = { ...m.headers, host:`localhost:${state.port}`, 'x-agentseye-relay':RELAY_TOKEN, 'x-agentseye-relay-ip':String(m.ip || ''), 'x-agentseye-relay-proto':m.proto === 'https' ? 'https' : 'http', 'x-agentseye-relay-mac':settings().macId };
  const req = http.request({ host:'127.0.0.1', port:state.port, method:m.method, path:m.path, headers }, res => {
    const out = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) if (!HOP.has(res.rawHeaders[i].toLowerCase())) out.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
    send({ t:'head', id:m.id, status:res.statusCode, headers:out });
    let buffered = Buffer.alloc(0);
    res.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= CHUNK) { send({ t:'body', id:m.id, data:buffered.subarray(0, CHUNK).toString('base64') }); buffered = buffered.subarray(CHUNK); }
    });
    res.on('end', () => { if (buffered.length) send({ t:'body', id:m.id, data:buffered.toString('base64') }); send({ t:'end', id:m.id }); });
    res.on('error', () => send({ t:'error', id:m.id }));
  });
  req.on('error', () => send({ t:'error', id:m.id, message:'AgentsEye on your Mac is not answering.' }));
  req.end(m.body ? Buffer.from(m.body, 'base64') : undefined);
}

export function boot(port = PORT) {
  state.port = port;
  if (settings().enabled) connect();
}
export const stop = () => { const s = settings(); s.enabled = false; disconnect(); };

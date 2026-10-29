#!/usr/bin/env node
// Self-hosted relay on Node: `node relay/server.js` (PORT, default 8787). Put it behind https in production
// (any reverse proxy or platform that terminates TLS and supports WebSockets).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, route, sha256, MAC_ID } from './core.js';

export function createRelay({ dataFile = '' } = {}) {
  const secrets = dataFile && fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : {};
  const save = () => { if (dataFile) fs.writeFileSync(dataFile, JSON.stringify(secrets, null, 2), { mode:0o600 }); };
  const rooms = new Map();
  const roomFor = mac => {
    if (!rooms.has(mac)) rooms.set(mac, new Room({ verify:async (id, secret) => {
      const hash = await sha256(`${id}:${secret}`);
      if (!secrets[id]) { secrets[id] = hash; save(); return true; }
      return secrets[id] === hash;
    } }));
    return rooms.get(mac);
  };
  const wss = new WebSocketServer({ noServer:true, maxPayload:2 * 1024 * 1024 });

  const server = http.createServer(async (req, res) => {
    try {
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const url = `${proto}://${req.headers.host}${req.url}`;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, { method:req.method, headers:Object.entries(req.headers).filter(([, v]) => typeof v === 'string'), body });
      const r = route(request, { repo:process.env.REPO || '' });
      const response = r.response || await roomFor(r.macId).forward(request, { ip:req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress });
      const headers = {};
      response.headers.forEach((v, k) => { if (k === 'set-cookie') (headers[k] ||= []).push(v); else headers[k] = v; });
      for (const c of response.headers.getSetCookie?.() || []) if (!headers['set-cookie']?.includes(c)) (headers['set-cookie'] ||= []).push(c);
      res.writeHead(response.status, headers);
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type':'text/plain' });
      res.end('Relay error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const mac = url.searchParams.get('mac') || '';
    if (url.pathname !== '/connect' || !MAC_ID.test(mac)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      const handlers = roomFor(mac).attach({ send:t => ws.send(t), close:(code, reason) => ws.close(code, reason) }, mac);
      ws.on('message', data => handlers.message(data.toString()));
      ws.on('close', handlers.close);
      ws.on('error', handlers.close);
    });
  });
  server.rooms = rooms;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const dataFile = process.env.RELAY_DATA || path.join(process.cwd(), 'relay-data.json');
  createRelay({ dataFile }).listen(port, () => console.log(`AgentsEye relay on http://localhost:${port}`));
}

// Cloudflare Workers entry. Each Mac gets its own Durable Object, which holds its WebSocket and stores the hash
// of its secret, so a Mac id can't be taken over by anyone else once registered.
import { Room, route, sha256, MAC_ID } from './core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const mac = url.searchParams.get('mac') || '';
      if (!MAC_ID.test(mac)) return new Response('Bad Mac id', { status:400 });
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status:426 });
      return env.MACS.get(env.MACS.idFromName(mac)).fetch(request);
    }
    const r = route(request);
    if (r.response) return r.response;
    const forwarded = new Request(request);
    forwarded.headers.set('x-lookout-mac', r.macId);
    forwarded.headers.set('x-lookout-ip', request.headers.get('cf-connecting-ip') || '');
    return env.MACS.get(env.MACS.idFromName(r.macId)).fetch(forwarded);
  },
};

export class MacRoom {
  constructor(state) {
    this.state = state;
    this.room = new Room({
      verify:async (mac, secret) => {
        const hash = await sha256(`${mac}:${secret}`);
        const saved = await this.state.storage.get('secret');
        if (!saved) { await this.state.storage.put('secret', hash); return true; }
        return saved === hash;
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const handlers = this.room.attach(server, url.searchParams.get('mac'));
      server.addEventListener('message', e => handlers.message(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)));
      server.addEventListener('close', handlers.close);
      server.addEventListener('error', handlers.close);
      return new Response(null, { status:101, webSocket:client });
    }
    const ip = request.headers.get('x-lookout-ip') || '';
    return this.room.forward(request, { ip });
  }
}

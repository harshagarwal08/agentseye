// Cloudflare Workers entry. Each Mac gets its own Durable Object, which holds its WebSocket and stores the hash
// of its secret, so a Mac id can't be taken over by anyone else once registered.
import { route, MAC_ID } from './core.js';
import { HibernatingMacRoom } from './mac-room.js';
import pkg from '../package.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const mac = url.searchParams.get('mac') || '';
      if (!MAC_ID.test(mac)) return new Response('Bad Mac id', { status:400 });
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status:426 });
      return env.MACS.get(env.MACS.idFromName(mac)).fetch(request);
    }
    const r = route(request, { repo:env.REPO || '' });
    if (r.response) return r.response;
    const forwarded = new Request(request);
    forwarded.headers.set('x-agentseye-mac', r.macId);
    forwarded.headers.set('x-agentseye-ip', request.headers.get('cf-connecting-ip') || '');
    return env.MACS.get(env.MACS.idFromName(r.macId)).fetch(forwarded);
  },
};

export class MacRoom extends HibernatingMacRoom {
  constructor(state, env) { super(state, env, pkg.version); }
}
